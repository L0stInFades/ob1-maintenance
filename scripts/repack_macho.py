#!/usr/bin/env python3
"""Resize an existing SEA segment without moving the native code/data segments.

Deliberately limited to this Mach-O layout: one NODE_SEA section immediately
before __LINKEDIT. Unknown load commands and overlapping ranges are rejected.
The caller removes the old signature before invoking this and signs afterwards.
"""
import argparse
import struct
from pathlib import Path


def repack(data, payload):
    if len(data) < 32 or struct.unpack_from('<I', data)[0] != 0xFEEDFACF:
        raise ValueError('Expected a 64-bit little-endian Mach-O')
    count, command_bytes = struct.unpack_from('<II', data, 16)
    commands = []
    segments = {}
    offset = 32
    for _ in range(count):
        if offset + 8 > 32 + command_bytes:
            raise ValueError('Truncated load command')
        command, size = struct.unpack_from('<II', data, offset)
        if size < 8 or offset + size > min(len(data), 32 + command_bytes):
            raise ValueError('Invalid load command')
        commands.append((command, offset, size))
        if command == 0x19:
            fields = struct.unpack_from('<II16sQQQQiiII', data, offset)
            name = fields[2].rstrip(b'\0').decode()
            segments[name] = dict(command=offset, vmaddr=fields[3], vmsize=fields[4],
                                  fileoff=fields[5], filesize=fields[6], sections=fields[-2])
        offset += size
    if offset != 32 + command_bytes:
        raise ValueError('Inconsistent load command sizes')
    sea, link = segments['NODE_SEA'], segments['__LINKEDIT']
    if sea['sections'] != 1 or link['sections'] != 0:
        raise ValueError('Unsupported SEA/LINKEDIT section layout')
    if struct.unpack_from('<16s', data, sea['command'] + 72)[0].rstrip(b'\0') != b'__NODE_SEA_BLOB':
        raise ValueError('Unexpected SEA section')
    page = 4096
    old_space = link['fileoff'] - sea['fileoff']
    new_space = (len(payload) + page - 1) // page * page
    if old_space != sea['vmsize'] or old_space < sea['filesize'] or old_space % page:
        raise ValueError('SEA must occupy an aligned region immediately before LINKEDIT')
    if sea['vmaddr'] + old_space != link['vmaddr']:
        raise ValueError('SEA/LINKEDIT virtual addresses are not contiguous')
    if link['fileoff'] + link['filesize'] > len(data):
        raise ValueError('Truncated LINKEDIT segment')
    for name, segment in segments.items():
        if name not in ('NODE_SEA', '__LINKEDIT') and segment['filesize']:
            if segment['fileoff'] + segment['filesize'] > sea['fileoff']:
                raise ValueError(f'Unexpected later segment: {name}')
    delta = new_space - old_space
    result = bytearray(data[:sea['fileoff']] + payload + bytes(new_space - len(payload)) + data[link['fileoff']:])
    struct.pack_into('<Q', result, sea['command'] + 32, new_space)
    struct.pack_into('<Q', result, sea['command'] + 48, len(payload))
    struct.pack_into('<Q', result, sea['command'] + 72 + 40, len(payload))
    struct.pack_into('<Q', result, link['command'] + 24, link['vmaddr'] + delta)
    struct.pack_into('<Q', result, link['command'] + 40, link['fileoff'] + delta)

    def shift32(location):
        value, = struct.unpack_from('<I', result, location)
        if value == 0:
            return
        if not link['fileoff'] <= value <= len(data):
            raise ValueError(f'Unexpected non-LINKEDIT file offset {value:#x}')
        struct.pack_into('<I', result, location, value + delta)

    # linkedit_data_command: dataoff/datasize (size is unchanged).
    linkedit_commands = {0x26, 0x29, 0x2B, 0x2E, 0x80000033, 0x80000034}
    no_offsets = {0x19, 0xE, 0x1B, 0x32, 0x2A, 0x80000028, 0xC, 0xD, 0x18,
                  0x80000018, 0x8000001C, 0x8000001F, 0x24, 0x25, 0x30}
    for command, position, size in commands:
        if command == 0x1D:
            raise ValueError('Remove the existing code signature before repacking')
        if command in linkedit_commands:
            shift32(position + 8)
        elif command == 0x2:  # LC_SYMTAB
            shift32(position + 8)
            shift32(position + 16)
        elif command == 0xB:  # LC_DYSYMTAB
            for index in (8, 10, 12, 14, 16, 18):
                shift32(position + index * 4)
        elif command in (0x22, 0x80000022):  # LC_DYLD_INFO[_ONLY]
            for index in (2, 4, 6, 8, 10):
                shift32(position + index * 4)
        elif command not in no_offsets:
            raise ValueError(f'Unsupported Mach-O load command {command:#x}')
    return bytes(result)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('staged_binary', type=Path)
    parser.add_argument('payload', type=Path)
    args = parser.parse_args()
    result = repack(args.staged_binary.read_bytes(), args.payload.read_bytes())
    args.staged_binary.write_bytes(result)
    print(f'Repacked {args.staged_binary}: {len(result)} bytes')
