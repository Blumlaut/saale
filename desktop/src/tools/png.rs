//! A minimal PNG encoder.
//!
//! The placeholder screenshot has to be a real image for the instance to render
//! it as one, and a capture backend is not in this build yet. Encoding it by
//! hand keeps a throwaway dependency out of the tree: RGB, no filtering, and
//! stored deflate blocks.

/// Encode 8-bit RGB pixels as a PNG.
pub fn encode_rgb(width: u32, height: u32, pixels: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);

    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    // Bit depth, colour type RGB, deflate, adaptive filtering, no interlace.
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    write_chunk(&mut out, b"IHDR", &ihdr);

    // Each scanline is prefixed with its filter type, 0 for none.
    let mut raw = Vec::with_capacity(pixels.len() + height as usize);
    let stride = width as usize * 3;
    for row in 0..height as usize {
        raw.push(0);
        raw.extend_from_slice(&pixels[row * stride..(row + 1) * stride]);
    }

    write_chunk(&mut out, b"IDAT", &zlib_stored(&raw));
    write_chunk(&mut out, b"IEND", &[]);
    out
}

fn write_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut crc_input = Vec::with_capacity(4 + data.len());
    crc_input.extend_from_slice(kind);
    crc_input.extend_from_slice(data);
    out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

/// A zlib stream of uncompressed blocks, which any decoder accepts.
fn zlib_stored(data: &[u8]) -> Vec<u8> {
    let mut out = vec![0x78, 0x01];
    let mut offset = 0;

    if data.is_empty() {
        out.extend_from_slice(&[0x01, 0x00, 0x00, 0xff, 0xff]);
    }

    while offset < data.len() {
        let len = (data.len() - offset).min(0xffff);
        let last = offset + len == data.len();
        out.push(if last { 0x01 } else { 0x00 });
        out.extend_from_slice(&(len as u16).to_le_bytes());
        out.extend_from_slice(&(!(len as u16)).to_le_bytes());
        out.extend_from_slice(&data[offset..offset + len]);
        offset += len;
    }

    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for byte in data {
        a = (a + *byte as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in data {
        crc ^= *byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_png_header_and_trailer() {
        let pixels = vec![0u8; 4 * 2 * 3];
        let png = encode_rgb(4, 2, &pixels);

        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
        assert_eq!(&png[png.len() - 8..png.len() - 4], b"IEND");
    }

    #[test]
    fn adler_matches_the_reference_value() {
        assert_eq!(adler32(b"Wikipedia"), 0x11e6_0398);
    }
}
