import importlib.util
import struct
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('extract_sea', ROOT / 'scripts/extract_sea.py')
extractor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extractor)


def string(value):
    return struct.pack('<Q', len(value)) + value


def blob(header=9, flags=1, suffix=b''):
    extra = {8: b'', 9: b'\x01', 10: b'\x01\x00'}[header]
    return struct.pack('<II', 0x0143DA20, flags) + extra + string(b'entry.cjs') + string(b'console.log("hello");\n') + suffix


class ExtractionTests(unittest.TestCase):
    def test_supported_header_generations(self):
        for size in (8, 9, 10):
            with self.subTest(size=size):
                meta, code, assets, cache = extractor.parse_sea(blob(size), size)
                self.assertEqual(meta['entry_path'], 'entry.cjs')
                self.assertEqual(code, b'console.log("hello");\n')
                self.assertEqual(assets, {})
                self.assertIsNone(cache)

    def test_truncated_and_trailing_data_rejected(self):
        for data in (blob()[:-1], blob() + b'x', blob()[:9]):
            with self.assertRaises(extractor.InvalidBinary):
                extractor.parse_sea(data, 9)

    def test_snapshot_is_not_misreported_as_source(self):
        with self.assertRaises(extractor.InvalidBinary):
            extractor.parse_sea(blob(flags=3), 9)

    def test_assets_cannot_traverse_or_escape(self):
        for name in (b'../secret', b'/secret', b'a/../../secret', b'a\\secret', b'a/./b'):
            with self.subTest(name=name), self.assertRaises(extractor.InvalidBinary):
                extractor.parse_sea(blob(flags=9, suffix=struct.pack('<Q', 1) + string(name) + string(b'asset')), 9)

    def test_assets_roundtrip(self):
        data = blob(flags=9, suffix=struct.pack('<Q', 1) + string(b'wasm/parser.wasm') + string(b'\0asm'))
        self.assertEqual(extractor.parse_sea(data, 9)[2], {'wasm/parser.wasm': b'\0asm'})

    def test_invalid_macho_and_load_commands(self):
        with self.assertRaises(extractor.InvalidBinary):
            extractor.macho_sections(b'\0' * 32)
        bad = struct.pack('<8I', 0xFEEDFACF, 0x1000007, 3, 2, 1, 8, 0, 0) + struct.pack('<II', 0x19, 0)
        with self.assertRaises(extractor.InvalidBinary):
            extractor.macho_sections(bad)

    def test_actual_payload_matches_saved_bytes(self):
        binary = (ROOT / 'original/bin/ob1').read_bytes()
        sections = extractor.macho_sections(binary)
        section = next(s for s in sections if s['section'] == '__NODE_SEA_BLOB')
        data = binary[section['offset']:section['offset'] + section['size']]
        meta, code, _, _ = extractor.parse_sea(data, 9)
        self.assertEqual(code, (ROOT / 'recovered/ob1.bundle.cjs').read_bytes())
        self.assertEqual(meta['code_size'], 21077351)


if __name__ == '__main__':
    unittest.main()
