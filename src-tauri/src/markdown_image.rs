use base64::Engine;
use reqwest::header::CONTENT_TYPE;
use std::time::Duration;
use url::Url;

const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_BYTES: usize = 20 * 1024 * 1024;
/// What the webview draws in an `<img>`, where an SVG runs no scripts and loads nothing.
const IMAGE_TYPES: [&str; 9] =
    ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/avif", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon"];

/// The image at the http(s) address `url`, as a `data:` URL. No cookies are sent or kept.
pub async fn load(url: &str) -> Result<String, String> {
    let url = Url::parse(url.trim()).map_err(|_| "That isn't a web address.".to_owned())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Only http:// and https:// images load.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Image addresses with a username or password in them don't load.".into());
    }
    let http = reqwest::Client::builder().timeout(TIMEOUT).build().map_err(|e| e.to_string())?;
    let mut resp = http.get(url).send().await.map_err(failed)?;
    if !resp.status().is_success() {
        return Err(format!("The site answered {}.", resp.status()));
    }
    let mime = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if !IMAGE_TYPES.contains(&mime.as_str()) {
        return Err("That address isn't an image.".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(failed)? {
        if body.len() + chunk.len() > MAX_BYTES {
            return Err("The image is bigger than 20 MB.".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(body)))
}

fn failed(e: reqwest::Error) -> String {
    if e.is_timeout() {
        format!("The image took longer than {} s.", TIMEOUT.as_secs())
    } else {
        "The image's site couldn't be reached.".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn serve(content_type: &'static str, body: Vec<u8>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = axum::Router::new().fallback(move || {
            let body = body.clone();
            async move { ([(CONTENT_TYPE, content_type)], body) }
        });
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}/p.png")
    }

    #[tokio::test]
    async fn an_image_comes_back_as_a_data_url() {
        let url = serve("Image/PNG; charset=binary", b"\x89PNG".to_vec()).await;
        assert_eq!(load(&url).await.unwrap(), "data:image/png;base64,iVBORw==");
    }

    #[tokio::test]
    async fn a_page_that_isnt_an_image_is_refused() {
        let url = serve("text/html", b"<img src=x>".to_vec()).await;
        assert_eq!(load(&url).await.unwrap_err(), "That address isn't an image.");
    }

    #[tokio::test]
    async fn an_image_over_20_mb_is_refused() {
        let url = serve("image/png", vec![0; MAX_BYTES + 1]).await;
        assert_eq!(load(&url).await.unwrap_err(), "The image is bigger than 20 MB.");
    }

    #[tokio::test]
    async fn only_http_and_https_addresses_without_credentials_load() {
        for url in ["file:///etc/passwd", "ftp://example.test/p.png", "data:image/png;base64,iVBORw=="] {
            assert_eq!(load(url).await.unwrap_err(), "Only http:// and https:// images load.", "{url}");
        }
        assert!(load("https://me:secret@example.test/p.png").await.unwrap_err().contains("username or password"));
        assert_eq!(load("not a url").await.unwrap_err(), "That isn't a web address.");
    }
}
