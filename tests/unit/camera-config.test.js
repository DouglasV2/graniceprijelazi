// Unit tests for the camera production fixes (2026-05-29):
//   1. HAK direct image URLs use the real cam.asp image ids, NOT the page-group `k` value.
//      (k != image id on HAK — deriving info/kamere/{k}.jpg returns a placeholder or the
//       wrong crossing's camera.)
//   2. `withHakImageFallbacks` appends the k-derived guess as a last resort, never first,
//      so explicit verified imageUrls always win.
//   3. `isUsableCameraImage` rejects PNG/GIF placeholders, tiny/broken payloads and HTML,
//      and accepts a sane-sized JPEG, so a placeholder is never analyzed as a real frame.

import { describe, it, expect } from 'vitest';
import {
  isUsableCameraImage,
  withHakImageFallbacks,
  CAMERA_FEEDS,
} from '../../server/index.js';

function firstImageUrl(crossingId, cameraId) {
  const cam = (CAMERA_FEEDS[crossingId] || []).find((c) => c.id === cameraId);
  return Array.isArray(cam?.imageUrls) ? cam.imageUrls[0] : '';
}

describe('HAK camera image URLs use the real image id (not the page `k`)', () => {
  // Verified against the live HAK pages on 2026-05-29 by reading the embedded
  // cam.asp?id=NNN ids out of each kamera.asp?k=... page.
  const expected = [
    ['gradiska', 'gra-hak-page', '404'],
    ['gornji-varos', 'gv-hak-queue-9', '1021'],
    ['gornji-varos', 'gv-hak-plaza-4', '1022'],
    ['svilaj', 'svi-hak', '461'],
    ['izacic', 'iza-hak-bih', '407'],
    ['vinjani-donji', 'vd-hak', '302'],
    ['vinjani-gornji', 'vg-hak', '994'],
    ['prisika', 'pri-hak-arzano', '315'],
    ['prisika', 'pri-hak-bih', '409'],
    ['brod', 'bro-hak-sb-ulaz-hr', '195'],
    ['brod', 'bro-hak-bb-izlaz-hr', '402'],
    ['samac', 'sam-hak', '1015'],
    ['kamensko', 'kam-hak', '317'],
    ['crveni-grm', 'cg-hak-bih', '410'],
    ['bijaca', 'bij-hak-ulaz-hr', '201'],
    ['bijaca', 'bij-hak-izlaz-hr', '202'],
  ];

  it.each(expected)('%s/%s primary image is info/kamere/%s.jpg', (crossingId, cameraId, id) => {
    expect(firstImageUrl(crossingId, cameraId)).toBe(`https://www.hak.hr/info/kamere/${id}.jpg`);
  });

  // Regression guards against the old placeholder-returning ids creeping back in.
  const forbidden = [
    ['svilaj', 'svi-hak', '211'],
    ['izacic', 'iza-hak-bih', '179'],
    ['vinjani-gornji', 'vg-hak', '282'],
    ['prisika', 'pri-hak-arzano', '193'],
    ['gornji-varos', 'gv-hak-queue-9', '303'], // 303 was actually the Vinjani Donji camera
  ];

  it.each(forbidden)('%s/%s no longer points at the bad id %s.jpg', (crossingId, cameraId, badId) => {
    const cam = (CAMERA_FEEDS[crossingId] || []).find((c) => c.id === cameraId);
    const urls = Array.isArray(cam?.imageUrls) ? cam.imageUrls : [];
    expect(urls[0]).not.toContain(`/${badId}.jpg`);
  });
});

describe('withHakImageFallbacks keeps explicit imageUrls first', () => {
  it('appends the k-derived guess after explicit verified urls', () => {
    const out = withHakImageFallbacks({
      id: 'x', url: 'https://m.hak.hr/kamera.asp?g=2&k=282',
      imageUrls: ['https://www.hak.hr/info/kamere/994.jpg'],
    });
    expect(out.imageUrls[0]).toBe('https://www.hak.hr/info/kamere/994.jpg');
    // k-derived guess (282.jpg) may be present but only as a trailing fallback.
    expect(out.imageUrls.indexOf('https://www.hak.hr/info/kamere/282.jpg')).toBeGreaterThan(0);
  });

  it('leaves non-HAK cameras untouched', () => {
    const cam = { id: 'y', url: 'https://bihamk.ba/spi/kamere', matchTexts: ['GP X'] };
    expect(withHakImageFallbacks(cam)).toEqual(cam);
  });
});

describe('isUsableCameraImage rejects placeholders and broken payloads', () => {
  const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const gifHeader = Buffer.from([0x47, 0x49, 0x46, 0x38]);

  const bigJpeg = Buffer.concat([jpegHeader, Buffer.alloc(90000, 0x20)]);
  const bigPng = Buffer.concat([pngHeader, Buffer.alloc(22841, 0x20)]); // HAK invalid-webcam placeholder
  const bigGif = Buffer.concat([gifHeader, Buffer.alloc(46000, 0x20)]); // m.hak.hr/cam.asp placeholder
  const tinyJpeg = Buffer.concat([jpegHeader, Buffer.alloc(200, 0x20)]);
  const htmlPage = Buffer.from('<html><body>error</body></html>'.repeat(200));

  it('accepts a sane-sized JPEG', () => {
    expect(isUsableCameraImage(bigJpeg, 'image/jpeg')).toBe(true);
  });
  it('rejects the HAK PNG invalid-webcam placeholder', () => {
    expect(isUsableCameraImage(bigPng, 'image/png')).toBe(false);
  });
  it('rejects a GIF placeholder', () => {
    expect(isUsableCameraImage(bigGif, 'image/gif')).toBe(false);
  });
  it('rejects a too-small / broken JPEG', () => {
    expect(isUsableCameraImage(tinyJpeg, 'image/jpeg')).toBe(false);
  });
  it('rejects an HTML error page', () => {
    expect(isUsableCameraImage(htmlPage, 'text/html')).toBe(false);
  });
  it('rejects empty / missing buffers', () => {
    expect(isUsableCameraImage(Buffer.alloc(0), 'image/jpeg')).toBe(false);
    expect(isUsableCameraImage(null, 'image/jpeg')).toBe(false);
  });
  it('rejects a JPEG-magic body served with a non-jpeg content-type', () => {
    expect(isUsableCameraImage(bigJpeg, 'image/png')).toBe(false);
  });
});
