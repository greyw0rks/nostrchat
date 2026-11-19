import { bech32, utils } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { parseBolt11 } from '../../nwc-gate/src/bolt11';
import { GateError } from '../../nwc-gate/src/types';

/** Check BOLT11 framing, checksum, tagged fields and ECDSA before wallet execution. */
export function signedBolt11(input: string) {
  const invoice = parseBolt11(input);
  try {
    const { prefix, words } = bech32.decode(invoice.bolt11 as `${string}1${string}`, 12_000);
    if (!/^ln(?:bc|tb|tbs|bcrt|sb)(?:\d+[munp]?)?$/.test(prefix) || words.length < 7 + 104) throw new Error();
    const data = words.slice(0, -104);
    const signature = bech32.fromWords(words.slice(-104));
    if (signature.length !== 65 || signature[64] > 3) throw new Error();
    let payee: Uint8Array | undefined;
    const fields = new Map<number, number>();
    for (let offset = 7; offset < data.length;) {
      if (offset + 3 > data.length) throw new Error();
      const type = data[offset];
      const length = data[offset + 1] * 32 + data[offset + 2];
      offset += 3;
      if (offset + length > data.length) throw new Error();
      fields.set(type, (fields.get(type) ?? 0) + 1);
      const value = data.slice(offset, offset + length);
      if ([1, 16, 23].includes(type) && (length !== 52 || bech32.fromWords(value).length !== 32)) throw new Error();
      if (type === 19) {
        if (length !== 53) throw new Error();
        payee = bech32.fromWords(value);
        if (payee.length !== 33) throw new Error();
      }
      offset += length;
    }
    if (fields.get(1) !== 1 || (fields.get(13) ?? 0) + (fields.get(23) ?? 0) !== 1 || (fields.get(19) ?? 0) > 1 || (fields.get(16) ?? 0) > 1) throw new Error();
    const prefixBytes = new TextEncoder().encode(prefix);
    const dataBytes = Uint8Array.from(utils.convertRadix2(data, 5, 8, true));
    const signed = new Uint8Array(prefixBytes.length + dataBytes.length);
    signed.set(prefixBytes); signed.set(dataBytes, prefixBytes.length);
    const hash = sha256(signed);
    if (!payee) {
      const recovered = new Uint8Array(65);
      recovered[0] = signature[64]; recovered.set(signature.subarray(0, 64), 1);
      payee = secp256k1.recoverPublicKey(recovered, hash, { prehash: false });
    }
    if (!secp256k1.verify(signature.subarray(0, 64), hash, payee, { prehash: false, lowS: false }) || !Number.isSafeInteger(invoice.expiresAt)) throw new Error();
    return { ...invoice, payeePubkey: Array.from(payee, byte => byte.toString(16).padStart(2, '0')).join('') };
  } catch { throw new GateError('INVALID_INVOICE_SIGNATURE', 'This Lightning invoice has an invalid checksum, signature, or payment data. Ask the sender for a fresh invoice.', 422); }
}
