//! AWS Signature Version 4 for S3 (`AWS4-HMAC-SHA256`), in the header form and the presigned-link form.

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

pub const ALGORITHM: &str = "AWS4-HMAC-SHA256";
/// The SHA-256 of no bytes, the payload hash of a request without a body.
pub const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/// A presigned link signs no payload.
pub const UNSIGNED_PAYLOAD: &str = "UNSIGNED-PAYLOAD";

pub fn hex_sha256(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes a key of any length");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

/// S3's `UriEncode`: every byte but `A-Z a-z 0-9 - . _ ~` as `%XX`, and `/` kept when it separates a path.
pub fn uri_encode(s: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') || (keep_slash && b == b'/') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The query as signed and as sent: each name and value encoded, sorted by name, then value.
pub fn canonical_query(query: &[(String, String)]) -> String {
    let mut pairs: Vec<(String, String)> = query.iter().map(|(k, v)| (uri_encode(k, false), uri_encode(v, false))).collect();
    pairs.sort();
    pairs.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&")
}

/// A request as it is signed. `path` is not yet encoded; `headers` are the ones to sign, `host` among them.
pub struct Request<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub query: &'a [(String, String)],
    pub headers: &'a [(String, String)],
    pub payload_hash: &'a str,
}

impl Request<'_> {
    /// The canonical request and its signed-headers list.
    pub fn canonical(&self) -> (String, String) {
        let mut headers: Vec<(String, String)> =
            self.headers.iter().map(|(k, v)| (k.to_ascii_lowercase(), v.split_whitespace().collect::<Vec<_>>().join(" "))).collect();
        headers.sort();
        let signed = headers.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(";");
        let lines: String = headers.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
        let text = format!("{}\n{}\n{}\n{lines}\n{signed}\n{}", self.method, uri_encode(self.path, true), canonical_query(self.query), self.payload_hash);
        (text, signed)
    }
}

/// An access key and the region it signs for.
pub struct Key<'a> {
    pub id: &'a str,
    pub secret: &'a str,
    pub region: &'a str,
}

impl Key<'_> {
    fn scope(&self, amz_date: &str) -> String {
        format!("{}/{}/s3/aws4_request", &amz_date[..8], self.region)
    }

    pub fn string_to_sign(&self, canonical_request: &str, amz_date: &str) -> String {
        format!("{ALGORITHM}\n{amz_date}\n{}\n{}", self.scope(amz_date), hex_sha256(canonical_request.as_bytes()))
    }

    fn sign(&self, string_to_sign: &str, amz_date: &str) -> String {
        let date = hmac(format!("AWS4{}", self.secret).as_bytes(), &amz_date[..8]);
        let region = hmac(&date, self.region);
        let service = hmac(&region, "s3");
        let signing = hmac(&service, "aws4_request");
        hex(&hmac(&signing, string_to_sign))
    }

    /// The signature of `request` at `amz_date` (`20130524T000000Z`).
    pub fn signature(&self, request: &Request, amz_date: &str) -> String {
        let (canonical, _) = request.canonical();
        self.sign(&self.string_to_sign(&canonical, amz_date), amz_date)
    }

    /// The `Authorization` header for `request`, which must sign `x-amz-date` and `x-amz-content-sha256`.
    pub fn authorization(&self, request: &Request, amz_date: &str) -> String {
        let (_, signed) = request.canonical();
        format!("{ALGORITHM} Credential={}/{},SignedHeaders={signed},Signature={}", self.id, self.scope(amz_date), self.signature(request, amz_date))
    }

    /// The query of a presigned link: `query` with the `X-Amz-*` parameters and the signature added. It signs only `host`.
    pub fn presign(&self, method: &str, host: &str, path: &str, query: &[(String, String)], amz_date: &str, expires: u64) -> Vec<(String, String)> {
        let mut signed_query = query.to_vec();
        signed_query.extend([
            ("X-Amz-Algorithm".to_string(), ALGORITHM.to_string()),
            ("X-Amz-Credential".to_string(), format!("{}/{}", self.id, self.scope(amz_date))),
            ("X-Amz-Date".to_string(), amz_date.to_string()),
            ("X-Amz-Expires".to_string(), expires.to_string()),
            ("X-Amz-SignedHeaders".to_string(), "host".to_string()),
        ]);
        let headers = [("host".to_string(), host.to_string())];
        let request = Request { method, path, query: &signed_query, headers: &headers, payload_hash: UNSIGNED_PAYLOAD };
        let signature = self.signature(&request, amz_date);
        signed_query.push(("X-Amz-Signature".to_string(), signature));
        signed_query
    }
}

#[cfg(test)]
mod tests {
    //! The worked examples in AWS's "Signature Calculations for the Authorization Header: Transferring Payload in a
    //! Single Chunk" and "Authenticating Requests: Using Query Parameters" (Amazon S3 developer guide).
    use super::*;

    const KEY: Key = Key { id: "AKIAIOSFODNN7EXAMPLE", secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1" };
    const DATE: &str = "20130524T000000Z";
    const HOST: &str = "examplebucket.s3.amazonaws.com";

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn get_object_matches_aws_example() {
        let headers = pairs(&[("Host", HOST), ("Range", "bytes=0-9"), ("x-amz-content-sha256", EMPTY_SHA256), ("x-amz-date", DATE)]);
        let request = Request { method: "GET", path: "/test.txt", query: &[], headers: &headers, payload_hash: EMPTY_SHA256 };
        let (canonical, _) = request.canonical();
        assert_eq!(hex_sha256(canonical.as_bytes()), "7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972");
        assert_eq!(
            KEY.authorization(&request, DATE),
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    }

    #[test]
    fn put_object_with_an_encoded_key_matches_aws_example() {
        let payload = "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072";
        assert_eq!(hex_sha256(b"Welcome to Amazon S3."), payload);
        let headers = pairs(&[
            ("Date", "Fri, 24 May 2013 00:00:00 GMT"),
            ("Host", HOST),
            ("x-amz-content-sha256", payload),
            ("x-amz-date", DATE),
            ("x-amz-storage-class", "REDUCED_REDUNDANCY"),
        ]);
        let request = Request { method: "PUT", path: "/test$file.text", query: &[], headers: &headers, payload_hash: payload };
        assert_eq!(KEY.signature(&request, DATE), "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
    }

    #[test]
    fn bucket_queries_match_aws_examples() {
        let headers = pairs(&[("Host", HOST), ("x-amz-content-sha256", EMPTY_SHA256), ("x-amz-date", DATE)]);
        let lifecycle = pairs(&[("lifecycle", "")]);
        let request = Request { method: "GET", path: "/", query: &lifecycle, headers: &headers, payload_hash: EMPTY_SHA256 };
        assert_eq!(KEY.signature(&request, DATE), "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543");

        let list = pairs(&[("prefix", "J"), ("max-keys", "2")]);
        let request = Request { method: "GET", path: "/", query: &list, headers: &headers, payload_hash: EMPTY_SHA256 };
        assert_eq!(request.canonical().0.lines().nth(2), Some("max-keys=2&prefix=J"));
        assert_eq!(KEY.signature(&request, DATE), "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
    }

    #[test]
    fn a_presigned_get_matches_aws_example() {
        let aws = "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404";
        let mut ours: Vec<String> = canonical_query(&KEY.presign("GET", HOST, "/test.txt", &[], DATE, 86400)).split('&').map(str::to_string).collect();
        let mut theirs: Vec<String> = aws.split('&').map(str::to_string).collect();
        ours.sort();
        theirs.sort();
        assert_eq!(ours, theirs);
    }

    #[test]
    fn uri_encoding_keeps_only_unreserved_bytes() {
        assert_eq!(uri_encode("a b/c+d~e_é", true), "a%20b/c%2Bd~e_%C3%A9");
        assert_eq!(uri_encode("a/b", false), "a%2Fb");
    }
}
