#!/usr/bin/env python3
"""Extract plaintext Node SEA resources from a little-endian 64-bit Mach-O.

Reads bytes only: never executes the input. Supports the 8, 9 and 10-byte
Node SEA headers; requires an unambiguous parse and full payload consumption.
Reference: nodejs/node src/node_sea.cc and src/node_serdes.h.
"""
import argparse
import hashlib
import json
import struct
from pathlib import Path, PurePosixPath


class InvalidBinary(ValueError):
    pass


def span(data, offset, size):
    if offset < 0 or size < 0 or offset + size > len(data):
        raise InvalidBinary(f"Out-of-bounds range: {offset}+{size}/{len(data)}")
    return data[offset:offset + size]


def macho_sections(data):
    header = struct.unpack('<8I', span(data, 0, 32))
    if header[0] != 0xFEEDFACF:
        raise InvalidBinary('Expected a little-endian 64-bit Mach-O')
    commands_end = 32 + header[5]
    span(data, 32, header[5])
    offset = 32
    result = []
    for _ in range(header[4]):
        command, size = struct.unpack('<II', span(data, offset, 8))
        if size < 8 or offset + size > commands_end:
            raise InvalidBinary('Invalid Mach-O load command')
        if command == 0x19:
            segment = struct.unpack('<II16sQQQQiiII', span(data, offset, 72))
            count = segment[-2]
            if 72 + count * 80 > size:
                raise InvalidBinary('Section table exceeds load command')
            for i in range(count):
                fields = struct.unpack('<16s16sQQIIIIIIII', span(data, offset + 72 + i * 80, 80))
                result.append(dict(section=fields[0].rstrip(b'\0').decode(),
                                   segment=fields[1].rstrip(b'\0').decode(),
                                   address=fields[2], size=fields[3], offset=fields[4]))
        offset += size
    if offset != commands_end:
        raise InvalidBinary('Load command size mismatch')
    return result


def parse_sea(data, header_size):
    magic, flags = struct.unpack('<II', span(data, 0, 8))
    if magic != 0x0143DA20 or flags & ~0x1F:
        raise InvalidBinary('Unknown SEA magic or flags')
    if flags & 2:
        raise InvalidBinary('V8 snapshots cannot be recovered as JavaScript')
    if header_size >= 9 and span(data, 8, 1)[0] > 2:
        raise InvalidBinary('Unknown exec argv extension')
    if header_size >= 10 and span(data, 9, 1)[0] > 1:
        raise InvalidBinary('Unknown main module format')
    offset = header_size

    def integer():
        nonlocal offset
        value, = struct.unpack('<Q', span(data, offset, 8))
        offset += 8
        return value

    def string():
        nonlocal offset
        size = integer()
        value = span(data, offset, size)
        offset += size
        return value

    code_path = string().decode('utf-8')
    if not code_path or '\0' in code_path:
        raise InvalidBinary('Invalid SEA entry path')
    code_size = integer()
    code_offset = offset
    code = span(data, offset, code_size)
    code.decode('utf-8')
    offset += code_size
    cache = string() if flags & 4 else None
    assets = {}
    if flags & 8:
        count = integer()
        if count > (len(data) - offset) // 16:
            raise InvalidBinary('Invalid asset count')
        for _ in range(count):
            key = string().decode('utf-8')
            path = PurePosixPath(key)
            if not key or '\\' in key or '\0' in key or path.is_absolute() or any(p in ('', '.', '..') for p in key.split('/')):
                raise InvalidBinary(f'Unsafe asset path: {key!r}')
            if key in assets:
                raise InvalidBinary('Duplicate asset name')
            assets[key] = string()
    argv = []
    if flags & 16:
        count = integer()
        if count > (len(data) - offset) // 8:
            raise InvalidBinary('Invalid argument count')
        argv = [string().decode('utf-8') for _ in range(count)]
    if offset != len(data):
        raise InvalidBinary(f'Unconsumed bytes: {len(data) - offset}')
    return dict(header_size=header_size, flags=flags, entry_path=code_path,
                code_offset_in_section=code_offset, code_size=code_size,
                exec_argv_extension=data[8] if header_size >= 9 else None,
                main_format=data[9] if header_size >= 10 else 0,
                exec_argv=argv), code, assets, cache


def extract(binary, output):
    data = binary.read_bytes()
    sections = macho_sections(data)
    candidates = [s for s in sections if s['segment'] == 'NODE_SEA' and s['section'] == '__NODE_SEA_BLOB']
    if len(candidates) != 1:
        raise InvalidBinary(f'Expected one SEA section, got {len(candidates)}')
    section = candidates[0]
    blob = span(data, section['offset'], section['size'])
    parses = []
    for header_size in (8, 9, 10):
        try:
            parses.append(parse_sea(blob, header_size))
        except (InvalidBinary, UnicodeError, struct.error):
            pass
    if len(parses) != 1:
        raise InvalidBinary(f'Expected one valid SEA layout, got {len(parses)}')
    metadata, code, assets, cache = parses[0]
    output.mkdir(parents=True, exist_ok=True)
    (output / 'ob1.bundle.cjs').write_bytes(code)
    for name, content in assets.items():
        target = output / 'assets' / name
        if not target.resolve().is_relative_to((output / 'assets').resolve()):
            raise InvalidBinary('Asset would escape output directory')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    if cache is not None:
        (output / 'v8-code-cache.bin').write_bytes(cache)
    metadata.update(binary_sha256=hashlib.sha256(data).hexdigest(),
                    binary_size=len(data), section=section,
                    code_sha256=hashlib.sha256(code).hexdigest(),
                    asset_names=list(assets), code_cache_size=len(cache) if cache else 0,
                    source_map_present=b'sourceMappingURL=' in code)
    (output / 'extraction.json').write_text(json.dumps(metadata, indent=2) + '\n')
    return metadata


if __name__ == '__main__':
    root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', nargs='?', type=Path, default=root / 'original/bin/ob1')
    parser.add_argument('--output', type=Path, default=root / 'recovered')
    args = parser.parse_args()
    print(json.dumps(extract(args.binary, args.output), indent=2))
