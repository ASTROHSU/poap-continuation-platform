export const HOLDINGS_MULTIPART_AUTH_SCHEME = "POAPin-Holdings-Multipart-HMAC-SHA256";
export const HOLDINGS_MULTIPART_CREATE_PATH = "/v1/holdings-multipart/create";
export const HOLDINGS_MULTIPART_PART_PATH = "/v1/holdings-multipart/part";
export const HOLDINGS_MULTIPART_COMPLETE_PATH = "/v1/holdings-multipart/complete";
export const HOLDINGS_MULTIPART_ABORT_PATH = "/v1/holdings-multipart/abort";
export const HOLDINGS_MULTIPART_MINIMUM_PART_BYTES = 5_242_880;
export const HOLDINGS_MULTIPART_MAXIMUM_PARTS = 10_000;

const PROTOCOL_LINE = "POAPIN-HOLDINGS-R2-MULTIPART/1";

export function createHoldingsMultipartSignaturePayload({
  method,
  path,
  bucket,
  snapshotId,
  key,
  byteLength,
  sha256,
  contentType,
  uploadId = "-",
  partNumber = 0,
  partByteLength = 0,
  bodySha256 = "-",
  timestamp,
}) {
  return [
    PROTOCOL_LINE,
    method,
    path,
    bucket,
    snapshotId,
    key,
    String(byteLength),
    sha256,
    contentType,
    uploadId,
    String(partNumber),
    String(partByteLength),
    bodySha256,
    String(timestamp),
  ].join("\n");
}
