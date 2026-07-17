// Minimal DNS responder: answers every A query with 127.0.0.1 and every AAAA
// with ::1. Only used for custom domains — macOS routes queries for the
// configured TLD here via an /etc/resolver/<domain> file (see `lhp setup`),
// so scoping to the domain happens at the OS level; we can answer everything.

import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';

const TYPE_A = 1;
const TYPE_AAAA = 28;

const LOOPBACK4 = Buffer.from([127, 0, 0, 1]);
const LOOPBACK6 = Buffer.concat([Buffer.alloc(15), Buffer.from([1])]);

function answer(query: Buffer): Buffer | null {
  // Header: id(2) flags(2) qd(2) an(2) ns(2) ar(2), then the question section.
  if (query.length < 12) return null;
  let offset = 12;
  while (offset < query.length && query[offset] !== 0) offset += query[offset]! + 1;
  offset += 1; // terminating zero label
  if (offset + 4 > query.length) return null;
  const qtype = query.readUInt16BE(offset);
  const question = query.subarray(12, offset + 4);

  const rdata = qtype === TYPE_A ? LOOPBACK4 : qtype === TYPE_AAAA ? LOOPBACK6 : null;

  const header = Buffer.alloc(12);
  query.copy(header, 0, 0, 2); // echo query id
  header.writeUInt16BE(0x8180, 2); // response, recursion desired + available
  header.writeUInt16BE(1, 4); // one question
  header.writeUInt16BE(rdata ? 1 : 0, 6); // one answer for A/AAAA, none otherwise
  if (!rdata) return Buffer.concat([header, question]);

  const record = Buffer.alloc(12 + rdata.length);
  record.writeUInt16BE(0xc00c, 0); // name: pointer to the question's name
  record.writeUInt16BE(qtype, 2);
  record.writeUInt16BE(1, 4); // class IN
  record.writeUInt32BE(60, 6); // ttl
  record.writeUInt16BE(rdata.length, 10);
  rdata.copy(record, 12);
  return Buffer.concat([header, question, record]);
}

export function startDnsServer(
  port: number,
  host: string,
  onReady?: (address: AddressInfo) => void
): dgram.Socket {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (query, rinfo) => {
    const response = answer(query);
    if (response) socket.send(response, rinfo.port, rinfo.address);
  });
  socket.on('error', (err) => {
    console.error(`dns server error: ${err.message}`);
    socket.close();
  });
  socket.bind(port, host, () => onReady?.(socket.address()));
  return socket;
}
