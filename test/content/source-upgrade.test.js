import test from 'node:test';
import assert from 'node:assert/strict';

import {
  imageResourceKey,
  imageUrlFromQuery,
  isSearchThumbnail,
  mediaWikiOriginal,
  parseSrcset,
  sameImageResource,
  upgradeCandidates,
} from '../../src/content/source-upgrade.js';

const BASE = 'https://example.test/page';

/** Candidate URLs only, for assertions that do not care about provenance. */
const urls = (/** @type {ReturnType<typeof upgradeCandidates>} */ ranked) => ranked.map((c) => c.url);

/** @param {Partial<Parameters<typeof upgradeCandidates>[0]>} overrides */
const input = (overrides) => ({
  current: 'https://cdn.test/thumb.jpg',
  shortEdge: 220,
  minShortEdge: 440,
  base: BASE,
  ...overrides,
});

test('no upgrade is proposed once the image can be scored on its own pixels', () => {
  // The gate is what keeps a second fetch per image off pages that do not need
  // one, so it has to hold even when better candidates exist.
  assert.deepEqual(
    upgradeCandidates(
      input({ shortEdge: 440, srcset: 'https://cdn.test/huge.jpg 4000w', linkHref: 'https://cdn.test/o.jpg' }),
    ),
    [],
  );
  assert.deepEqual(upgradeCandidates(input({ shortEdge: 0, srcset: 'https://cdn.test/huge.jpg 4000w' })), []);
});

test('srcset outranks data attributes, which outrank the ancestor link', () => {
  const ranked = upgradeCandidates(
    input({
      srcset: 'https://cdn.test/w800.jpg 800w',
      dataset: { largeFile: 'https://cdn.test/large.jpg' },
      linkHref: 'https://cdn.test/linked.jpg',
    }),
  );
  assert.deepEqual(urls(ranked), [
    'https://cdn.test/w800.jpg',
    'https://cdn.test/large.jpg',
    'https://cdn.test/linked.jpg',
  ]);
});

test('parseSrcset ranks by width and ignores x descriptors', () => {
  const parsed = parseSrcset(
    'https://cdn.test/a.jpg 400w, https://cdn.test/c.jpg 1600w, https://cdn.test/b.jpg 800w, https://cdn.test/d.jpg 2x',
    BASE,
  );
  assert.deepEqual(
    parsed.map((c) => c.width),
    [1600, 800, 400],
  );
  assert.ok(!parsed.some((c) => c.url.endsWith('d.jpg')), 'x descriptor carries no pixel count');
});

test('parseSrcset survives commas inside CDN transform URLs', () => {
  const parsed = parseSrcset(
    'https://res.cdn.test/upload/w_400,h_300/cat.jpg 400w,https://res.cdn.test/upload/w_1600,h_1200/cat.jpg 1600w',
    BASE,
  );
  assert.deepEqual(parsed.map((c) => c.width), [1600, 400]);
  assert.equal(parsed[0]?.url, 'https://res.cdn.test/upload/w_1600,h_1200/cat.jpg');
});

test('parseSrcset resolves relative candidates against the document base', () => {
  assert.equal(parseSrcset('/img/big.jpg 900w', BASE)[0]?.url, 'https://example.test/img/big.jpg');
});

test('imageUrlFromQuery unwraps search-engine and proxy redirectors', () => {
  assert.equal(
    imageUrlFromQuery(
      'https://www.google.com/imgres?q=cats&imgurl=https%3A%2F%2Fcdn.britannica.com%2F70%2Fcat.jpg&docid=x',
    ),
    'https://cdn.britannica.com/70/cat.jpg',
  );
  assert.equal(
    imageUrlFromQuery('https://www.bing.com/images/search?mediaurl=https%3A%2F%2Fhost.test%2Fp.png'),
    'https://host.test/p.png',
  );
  assert.equal(
    imageUrlFromQuery('https://images.search.yahoo.com/search/images?ou=https%3A%2F%2Fcdn.test%2Fa.jpg'),
    'https://cdn.test/a.jpg',
  );
  assert.equal(
    imageUrlFromQuery('https://example.test/view?iu=https%3A%2F%2Fcdn.test%2Fb.png'),
    'https://cdn.test/b.png',
  );
  assert.equal(imageUrlFromQuery('https://example.test/article/cats'), null);
  assert.equal(imageUrlFromQuery('not a url'), null);
  assert.equal(imageUrlFromQuery(null), null);
});

test('imgurl wins over a generic url parameter that often holds the article', () => {
  assert.equal(
    imageUrlFromQuery(
      'https://www.google.com/imgres?url=https%3A%2F%2Fwww.fandom.com%2Fhello-kitty&imgurl=https%3A%2F%2Fstatic.wikia.nocookie.net%2FHello_Kitty.jpg',
    ),
    'https://static.wikia.nocookie.net/Hello_Kitty.jpg',
  );
});

test('a bare ancestor link is only taken when it points straight at an image', () => {
  assert.deepEqual(upgradeCandidates(input({ linkHref: 'https://example.test/articles/cats' })), []);
  assert.deepEqual(urls(upgradeCandidates(input({ linkHref: 'https://cdn.test/full.jpeg?v=2' }))), [
    'https://cdn.test/full.jpeg?v=2',
  ]);
});

test('non-http schemes are never proposed as upgrades', () => {
  assert.deepEqual(
    upgradeCandidates(
      input({
        dataset: { src: 'file:///C:/secrets/passwords.png', original: 'javascript:alert(1)' },
        linkHref: 'chrome-extension://abc/x.png',
      }),
    ),
    [],
  );
});

test('the current source is never proposed as its own upgrade', () => {
  assert.deepEqual(
    upgradeCandidates(
      input({
        current: 'https://cdn.test/thumb.jpg',
        srcset: 'https://cdn.test/thumb.jpg 800w',
        dataset: { src: 'https://cdn.test/thumb.jpg' },
      }),
    ),
    [],
  );
});

test('duplicates collapse and the probe budget is respected', () => {
  const ranked = upgradeCandidates(
    input({
      srcset: 'https://cdn.test/a.jpg 800w, https://cdn.test/b.jpg 900w, https://cdn.test/c.jpg 1000w',
      dataset: { largeFile: 'https://cdn.test/a.jpg', zoomSrc: 'https://cdn.test/d.jpg' },
      limit: 3,
    }),
  );
  assert.equal(ranked.length, 3);
  assert.equal(new Set(urls(ranked)).size, 3);
});

test('srcset entries no wider than the rendered image are skipped', () => {
  assert.deepEqual(
    upgradeCandidates(input({ shortEdge: 220, srcset: 'https://cdn.test/small.jpg 200w' })),
    [],
  );
});

test('mediaWikiOriginal strips the derivative back to the source file', () => {
  assert.equal(
    mediaWikiOriginal(
      'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4d/Cat_November_2010-1a.jpg/960px-Cat_November_2010-1a.jpg',
    ),
    'https://upload.wikimedia.org/wikipedia/commons/4/4d/Cat_November_2010-1a.jpg',
  );
  // Multi-page formats carry an extra prefix before the size segment.
  assert.equal(
    mediaWikiOriginal(
      'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Doc.tif/lossy-page1-800px-Doc.tif.jpg',
    ),
    'https://upload.wikimedia.org/wikipedia/commons/a/ab/Doc.tif',
  );
  // Not a derivative: no size segment, so the path is left alone.
  assert.equal(
    mediaWikiOriginal('https://upload.wikimedia.org/wikipedia/commons/4/4d/Cat_November_2010-1a.jpg'),
    null,
  );
  assert.equal(mediaWikiOriginal('https://example.test/thumb/gallery/photo.jpg'), null);
  assert.equal(mediaWikiOriginal(null), null);
});

test('a rendered MediaWiki derivative upgrades to its original', () => {
  // Wikipedia articles render a small derivative with no srcset width
  // descriptors and no link to the file, so this is the only route to the
  // original pixels.
  assert.deepEqual(
    urls(
      upgradeCandidates(
        input({
          current:
            'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4d/Cat_November_2010-1a.jpg/220px-Cat_November_2010-1a.jpg',
          shortEdge: 165,
        }),
      ),
    ),
    ['https://upload.wikimedia.org/wikipedia/commons/4/4d/Cat_November_2010-1a.jpg'],
  );
});

test('the original outranks the derivative that named it', () => {
  const ranked = upgradeCandidates(
    input({
      linkHref:
        'https://www.google.com/imgres?imgurl=https%3A%2F%2Fupload.wikimedia.org%2Fwikipedia%2Fcommons%2Fthumb%2F4%2F4d%2FCat_November_2010-1a.jpg%2F960px-Cat_November_2010-1a.jpg',
    }),
  );
  assert.deepEqual(urls(ranked), [
    'https://upload.wikimedia.org/wikipedia/commons/4/4d/Cat_November_2010-1a.jpg',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4d/Cat_November_2010-1a.jpg/960px-Cat_November_2010-1a.jpg',
  ]);
});

test('the Google Images case resolves to the origin CDN', () => {
  // The reported false positive: a 259px gstatic thumbnail badged AI while the
  // Britannica original scored well below the threshold.
  assert.deepEqual(
    urls(
      upgradeCandidates(
        input({
          current: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9Gc',
          shortEdge: 259,
          linkHref:
            'https://www.google.com/imgres?q=cats&imgurl=https%3A%2F%2Fcdn.britannica.com%2F70%2F234870-050%2FOrange-colored-cat-yawns.jpg&imgrefurl=https%3A%2F%2Fwww.britannica.com%2Fanimal%2Fcat',
        }),
      ),
    ),
    ['https://cdn.britannica.com/70/234870-050/Orange-colored-cat-yawns.jpg'],
  );
});

test('a redirector parameter is same-file; only a bare link is geometry-checked', () => {
  // The Britannica false positive: Google crops its grid thumbnail, so an
  // aspect-ratio veto would have discarded the origin URL Google itself named —
  // the one source that scores the picture correctly.
  const [redirected] = upgradeCandidates(
    input({
      linkHref:
        'https://www.google.com/imgres?imgurl=https%3A%2F%2Fcdn.britannica.com%2F70%2Fcat.jpg',
    }),
  );
  assert.equal(redirected?.confidence, 'same-file');

  const [bare] = upgradeCandidates(input({ linkHref: 'https://cdn.test/gallery-next.jpg' }));
  assert.equal(bare?.confidence, 'linked');

  // srcset siblings and lazy-load attributes are the same file too.
  const ranked = upgradeCandidates(
    input({ srcset: 'https://cdn.test/w900.jpg 900w', dataset: { zoomSrc: 'https://cdn.test/zoom.jpg' } }),
  );
  assert.deepEqual(
    ranked.map((c) => c.confidence),
    ['same-file', 'same-file'],
  );
});

test('isSearchThumbnail matches Google encrypted-tbn and Bing TSE hosts', () => {
  assert.equal(isSearchThumbnail('https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9'), true);
  assert.equal(isSearchThumbnail('https://encrypted-tbn3.gstatic.com/images?q=tbn:ANd9'), true);
  assert.equal(isSearchThumbnail('https://tse1.mm.bing.net/th?id=OIP.abc'), true);
  assert.equal(isSearchThumbnail('https://images.pexels.com/photos/cat.jpg'), false);
  assert.equal(isSearchThumbnail('https://cdn.britannica.com/70/cat.jpg'), false);
  assert.equal(isSearchThumbnail(null), false);
});

test('a large Google thumbnail still upgrades to the named original', () => {
  // High-DPR grids serve encrypted-tbn well above 440px. Scoring those pixels
  // is what made the tile badge AI 66% while the preview of the same Pexels
  // file, already at native resolution, badged 2%.
  assert.deepEqual(
    urls(
      upgradeCandidates(
        input({
          current: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcThumb',
          shortEdge: 512,
          linkHref:
            'https://www.google.com/imgres?imgurl=https%3A%2F%2Fimages.pexels.com%2Fphotos%2Fcat.jpg',
        }),
      ),
    ),
    ['https://images.pexels.com/photos/cat.jpg'],
  );
});

test('an ordinary large photograph still skips the upgrade hunt', () => {
  assert.deepEqual(
    upgradeCandidates(
      input({
        current: 'https://images.pexels.com/photos/cat.jpg',
        shortEdge: 512,
        linkHref:
          'https://www.google.com/imgres?imgurl=https%3A%2F%2Fimages.pexels.com%2Fphotos%2Fother.jpg',
      }),
    ),
    [],
  );
});

test('an overlay sibling href is enough when the wrapping <a> is missing', () => {
  assert.deepEqual(
    urls(
      upgradeCandidates(
        input({
          current: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9',
          linkHref: null,
          linkHrefs: [
            'https://www.google.com/imgres?imgurl=https%3A%2F%2Fimages.pexels.com%2Fphotos%2Fcat.jpg',
          ],
        }),
      ),
    ),
    ['https://images.pexels.com/photos/cat.jpg'],
  );
});

test('imageResourceKey ignores CDN query strings and www', () => {
  assert.equal(
    imageResourceKey('https://cdn.test/photos/cat.jpg?w=1600'),
    imageResourceKey('https://www.cdn.test/photos/cat.jpg'),
  );
  assert.ok(
    sameImageResource(
      'https://static.wikia.nocookie.net/Hello_Kitty.jpg/revision/latest/scale-to-width-down/268',
      'https://static.wikia.nocookie.net/Hello_Kitty.jpg/revision/latest/scale-to-width-down/268?cb=1',
    ),
  );
  assert.equal(
    sameImageResource('https://cdn.test/a.jpg', 'https://cdn.test/b.jpg'),
    false,
  );
  assert.equal(imageResourceKey('https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9'), '');
});

test('imageResourceKey maps a MediaWiki derivative to the original file', () => {
  assert.ok(
    sameImageResource(
      'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4d/Cat.jpg/960px-Cat.jpg',
      'https://upload.wikimedia.org/wikipedia/commons/4/4d/Cat.jpg',
    ),
  );
});
