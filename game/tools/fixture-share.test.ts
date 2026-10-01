import { describe, expect, it } from 'vitest';
import { jpegSize } from './fixture-share.ts';

describe('jpegSize', () => {
  it('reads the SOF header and refuses what is not a JPEG', () => {
    // SOI, an APP0 of 4 bytes, SOF0 with 720 × 1280.
    const b = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03, 0, 0, 0, 0, 0, 0]);
    expect(jpegSize(b)).toEqual({ w: 1280, h: 720 });
    expect(jpegSize(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'))).toBeNull();
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
  });
});
