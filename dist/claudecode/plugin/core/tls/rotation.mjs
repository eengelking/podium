// A planned CA rotation's new CA, checked before it is stored (#588, #948). Shared by every reporter that makes the mTLS connection (#927).
import { X509Certificate } from 'node:crypto';

/**
 * A planned CA rotation's new CA (#588): `{ ca, cross }`, the new CA and a certificate for it signed by a CA this file already
 * holds. Returns the new CA's PEM and whether the file holds it, or throws. The cross certificate is checked and dropped, never
 * stored, because parseConfig would read it as one more trust anchor. A held CA is never replaced or removed.
 */
export function acceptRotation(rotation, held) {
  if (typeof rotation?.ca !== 'string' || typeof rotation?.cross !== 'string') throw new Error('the rotation is missing the new CA or the cross certificate');
  let ca;
  let cross;
  try {
    ca = new X509Certificate(rotation.ca);
    cross = new X509Certificate(rotation.cross);
  } catch {
    throw new Error('the rotation holds a certificate that cannot be read');
  }
  const now = Date.now();
  if (!ca.ca || !cross.ca) throw new Error('the rotation is not made of CA certificates');
  if (!held.some((c) => cross.verify(new X509Certificate(c).publicKey))) throw new Error('the cross certificate is not signed by a CA in the file');
  if (!ca.publicKey.equals(cross.publicKey) || ca.subject !== cross.subject) throw new Error('the cross certificate is not for the new CA');
  for (const c of [ca, cross]) if (Date.parse(c.validFrom) > now || Date.parse(c.validTo) <= now) throw new Error('a certificate in the rotation is not valid now');
  return { pem: rotation.ca, held: held.some((c) => new X509Certificate(c).fingerprint256 === ca.fingerprint256) };
}
