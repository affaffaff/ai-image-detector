"""Deterministic nuisance features for the explain-it-away null shootout.

Pixel intake matches docs/eval-protocol.md §2: stored bytes, EXIF transpose,
mean-fill alpha composite, Rec.601 luma on gamma-encoded 8-bit sRGB. Probes
B1–B5 match §3. Extra codec / appearance / band features are labelled as
extensions; they never change B1–B5.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageOps

MEAN_FILL = (124, 116, 104)
LUMA = np.asarray([0.299, 0.587, 0.114], dtype=np.float64)
FFT_BAND_EDGES = (0.0, 0.15, 0.30, 0.45, 0.60, 0.75, 1.00, math.sqrt(2.0))
DCT_BAND_EDGES = (0.0, 0.25, 0.50, 0.75, 1.01)


def _dct8_matrix() -> np.ndarray:
    n = 8
    k = np.arange(n).reshape(-1, 1)
    x = np.arange(n).reshape(1, -1)
    matrix = np.cos(np.pi * (2 * x + 1) * k / (2 * n))
    matrix[0, :] *= np.sqrt(1 / n)
    matrix[1:, :] *= np.sqrt(2 / n)
    return matrix


DCT8 = _dct8_matrix()


def jpeg_codec_features_from(opened: Image.Image, codec: str) -> dict[str, float]:
    features = {
        "is_jpeg": 1.0 if codec in {"jpeg", "jpg"} else 0.0,
        "is_png": 1.0 if codec == "png" else 0.0,
        "is_webp": 1.0 if codec == "webp" else 0.0,
        "jpeg_qmean": float("nan"),
        "jpeg_quality_proxy": float("nan"),
        "chroma_h": float("nan"),
        "chroma_v": float("nan"),
        "has_exif": 0.0,
        "has_icc": 0.0,
        "has_software": 0.0,
        "has_comment": 0.0,
        "has_xmp": 0.0,
    }
    info = opened.info
    features["has_exif"] = 1.0 if opened.getexif() else 0.0
    features["has_icc"] = 1.0 if info.get("icc_profile") else 0.0
    software = str(info.get("software") or "")
    features["has_software"] = 1.0 if software.strip() else 0.0
    features["has_comment"] = 1.0 if info.get("comment") else 0.0
    features["has_xmp"] = 1.0 if info.get("xmp") or info.get("XML:com.adobe.xmp") else 0.0
    tables = getattr(opened, "quantization", None) or {}
    luma_table = tables.get(0) or (next(iter(tables.values())) if tables else None)
    if luma_table is not None:
        mean_q = float(np.mean(np.asarray(luma_table, dtype=np.float64)))
        features["jpeg_qmean"] = mean_q
        features["jpeg_quality_proxy"] = float(np.clip(100.0 - mean_q * 100.0 / 255.0, 1.0, 100.0))
    layers = getattr(opened, "layer", None)
    if layers and len(layers) >= 2:
        chroma = layers[1]
        features["chroma_h"] = float(chroma[1])
        features["chroma_v"] = float(chroma[2])
    elif codec in {"jpeg", "jpg"}:
        features["chroma_h"] = 1.0
        features["chroma_v"] = 1.0
    return features


def load_rgb(path: Path) -> tuple[np.ndarray, str, int, dict[str, float]]:
    """Return RGB, codec, stored bytes, and codec/metadata features from one open."""
    stored_bytes = path.stat().st_size
    with Image.open(path) as opened:
        codec = (opened.format or path.suffix.lstrip(".")).lower()
        codec_features = jpeg_codec_features_from(opened, codec)
        transposed = ImageOps.exif_transpose(opened)
        if transposed.mode in {"RGBA", "LA"} or "transparency" in transposed.info:
            rgba = transposed.convert("RGBA")
            canvas = Image.new("RGB", rgba.size, MEAN_FILL)
            canvas.paste(rgba, mask=rgba.split()[-1])
            rgb = canvas
        else:
            rgb = transposed.convert("RGB")
        pixels = np.asarray(rgb, dtype=np.uint8)
    if pixels.ndim != 3 or pixels.shape[2] != 3:
        raise ValueError(f"{path} did not decode to RGB")
    return pixels, codec, stored_bytes, codec_features


def luma_plane(rgb: np.ndarray) -> np.ndarray:
    return np.tensordot(rgb.astype(np.float64), LUMA, axes=([2], [0]))


def log10_safe(value: float, eps: float = 1e-12) -> float:
    return float(math.log10(max(eps, value)))


def b1_log_pixels(width: int, height: int) -> float:
    return log10_safe(float(width) * float(height))


def b2_log_bytes(stored_bytes: int) -> float:
    return log10_safe(float(stored_bytes))


def b3_log_density(stored_bytes: int, width: int, height: int) -> float:
    return log10_safe(float(stored_bytes) / max(1.0, float(width) * float(height)))


def windowed_magnitude_spectrum(luma: np.ndarray) -> np.ndarray:
    height, width = luma.shape
    centered = luma - float(luma.mean())
    windowed = centered * np.hanning(height)[:, None] * np.hanning(width)[None, :]
    return np.abs(np.fft.fftshift(np.fft.fft2(windowed)))


def _radial_frequency(height: int, width: int) -> np.ndarray:
    fy = (np.arange(height) - (height // 2)) / (height / 2.0)
    fx = (np.arange(width) - (width // 2)) / (width / 2.0)
    return np.hypot(fy[:, None], fx[None, :])


def b4_spectral_ratio(luma: np.ndarray, spectrum: np.ndarray | None = None) -> float | None:
    height, width = luma.shape
    if min(height, width) < 64:
        return None
    if spectrum is None:
        spectrum = windowed_magnitude_spectrum(luma)
    radius = _radial_frequency(height, width)
    low = radius <= 0.20
    low[height // 2, width // 2] = False
    high = radius >= 0.70
    if not bool(low.any()) or not bool(high.any()):
        return None
    return math.log10(
        (float(spectrum[high].mean()) + 1e-12) / (float(spectrum[low].mean()) + 1e-12)
    )


def b5_jpeg_blockiness(luma: np.ndarray, grid: int = 8) -> float | None:
    height, width = luma.shape
    if min(height, width) < 24:
        return None
    vertical = np.abs(np.diff(luma, axis=0))
    horizontal = np.abs(np.diff(luma, axis=1))
    v_on = vertical[(np.arange(height - 1) % grid) == (grid - 1)]
    h_on = horizontal[:, (np.arange(width - 1) % grid) == (grid - 1)]
    v_off = vertical[(np.arange(height - 1) % grid) != (grid - 1)]
    h_off = horizontal[:, (np.arange(width - 1) % grid) != (grid - 1)]
    on_grid = np.concatenate([v_on.reshape(-1), h_on.reshape(-1)])
    off_grid = np.concatenate([v_off.reshape(-1), h_off.reshape(-1)])
    if on_grid.size == 0 or off_grid.size == 0:
        return None
    return math.log10((float(on_grid.mean()) + 1e-6) / (float(off_grid.mean()) + 1e-6))


def fft_radial_bands(luma: np.ndarray, spectrum: np.ndarray | None = None) -> list[float] | None:
    height, width = luma.shape
    if min(height, width) < 64:
        return None
    if spectrum is None:
        spectrum = windowed_magnitude_spectrum(luma)
    radius = _radial_frequency(height, width)
    bands: list[float] = []
    for left, right in zip(FFT_BAND_EDGES[:-1], FFT_BAND_EDGES[1:]):
        mask = (radius >= left) & (radius < right)
        if left == 0.0:
            mask[height // 2, width // 2] = False
        bands.append(log10_safe(float(spectrum[mask].mean()) + 1e-12) if mask.any() else float("nan"))
    return bands


def dct_radial_bands(luma: np.ndarray) -> list[float] | None:
    height, width = luma.shape
    if min(height, width) < 24:
        return None
    max_side = 512
    if height > max_side:
        top = (height - max_side) // 2
        luma = luma[top:top + max_side, :]
        height = int(luma.shape[0])
    if width > max_side:
        left = (width - max_side) // 2
        luma = luma[:, left:left + max_side]
        width = int(luma.shape[1])
    usable_h = height - (height % 8)
    usable_w = width - (width % 8)
    if usable_h < 16 or usable_w < 16:
        return None
    blocks = luma[:usable_h, :usable_w].reshape(usable_h // 8, 8, usable_w // 8, 8)
    coeffs = np.einsum("ij,ajbk,lk->aibl", DCT8, blocks, DCT8)
    energy = np.abs(coeffs).mean(axis=(0, 2))
    uu = np.arange(8)[:, None] / 7.0
    vv = np.arange(8)[None, :] / 7.0
    radius = np.hypot(uu, vv)
    bands: list[float] = []
    for left, right in zip(DCT_BAND_EDGES[:-1], DCT_BAND_EDGES[1:]):
        mask = (radius >= left) & (radius < right)
        bands.append(log10_safe(float(energy[mask].mean()) + 1e-12) if mask.any() else float("nan"))
    low = radius <= 0.25
    high = radius >= 0.75
    ratio = log10_safe(float(energy[high].mean()) + 1e-12) - log10_safe(float(energy[low].mean()) + 1e-12)
    bands.append(ratio)
    return bands


def appearance_features(rgb: np.ndarray, luma: np.ndarray) -> dict[str, float]:
    flat = rgb.reshape(-1, 3).astype(np.float64)
    dx = np.abs(np.diff(luma, axis=1)).mean() if luma.shape[1] > 1 else 0.0
    dy = np.abs(np.diff(luma, axis=0)).mean() if luma.shape[0] > 1 else 0.0
    lap = (
        -4.0 * luma
        + np.roll(luma, 1, 0)
        + np.roll(luma, -1, 0)
        + np.roll(luma, 1, 1)
        + np.roll(luma, -1, 1)
    )
    saturation = flat.max(axis=1) - flat.min(axis=1)
    histogram, _ = np.histogram(luma, bins=32, range=(0.0, 255.0), density=False)
    probabilities = histogram.astype(np.float64) / max(1, int(histogram.sum()))
    nonzero = probabilities[probabilities > 0]
    return {
        "mean_r": float(flat[:, 0].mean()),
        "mean_g": float(flat[:, 1].mean()),
        "mean_b": float(flat[:, 2].mean()),
        "std_r": float(flat[:, 0].std()),
        "std_g": float(flat[:, 1].std()),
        "std_b": float(flat[:, 2].std()),
        "luma_mean": float(luma.mean()),
        "luma_std": float(luma.std()),
        "contrast_range": float(luma.max() - luma.min()),
        "noise_lapvar": float(lap.var()),
        "edge_x": float(dx),
        "edge_y": float(dy),
        "edge_energy": float(dx + dy),
        "saturation_mean": float(saturation.mean()),
        "clipped_fraction": float(np.mean((flat <= 1.0) | (flat >= 254.0))),
        "luma_entropy": float(-np.sum(nonzero * np.log2(nonzero))),
    }


def pixels32(rgb: np.ndarray) -> np.ndarray:
    image = Image.fromarray(rgb, mode="RGB").resize((32, 32), Image.Resampling.BILINEAR)
    return (np.asarray(image, dtype=np.float32) / np.float32(255.0)).reshape(-1)


def extract_features(path: Path) -> dict[str, Any]:
    rgb, codec, stored_bytes, codec_features = load_rgb(path)
    height, width = int(rgb.shape[0]), int(rgb.shape[1])
    luma = luma_plane(rgb)
    spectrum = windowed_magnitude_spectrum(luma) if min(height, width) >= 64 else None
    features: dict[str, Any] = {
        "width": float(width),
        "height": float(height),
        "aspect": math.log(max(width, 1) / max(height, 1)),
        "b1_log_pixels": b1_log_pixels(width, height),
        "b2_log_bytes": b2_log_bytes(stored_bytes),
        "b3_log_density": b3_log_density(stored_bytes, width, height),
        "stored_bytes": float(stored_bytes),
        "codec": codec,
        "b4_spectral": b4_spectral_ratio(luma, spectrum),
        "b5_blockiness": b5_jpeg_blockiness(luma),
    }
    features.update(codec_features)
    features.update(appearance_features(rgb, luma))
    features["_fft_bands"] = fft_radial_bands(luma, spectrum)
    features["_dct_bands"] = dct_radial_bands(luma)
    features["_pixels32"] = pixels32(rgb)
    return features
