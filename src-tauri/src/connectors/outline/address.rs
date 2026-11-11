//! The Outline address as the manager typed it, cut to its root
//! (`outline-connector`, «Адрес Outline»; design.md, decision 5).

/// Hosts that may go over plain `http`: a self-hosted Outline on this
/// machine.
const LOCAL_HOSTS: [&str; 2] = ["localhost", "127.0.0.1"];

/// `scheme://host[:port]` of whatever was typed: no scheme means `https`;
/// a path, query or fragment goes; `http` only for `localhost` and
/// `127.0.0.1`. `Err` with what to show under the address field.
pub fn normalize(input: &str) -> Result<String, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("Введите адрес Outline".to_owned());
    }
    let (scheme, rest) = match input.split_once("://") {
        Some((scheme, rest)) => (scheme.to_ascii_lowercase(), rest),
        None => ("https".to_owned(), input),
    };
    if scheme != "https" && scheme != "http" {
        return Err("Нужен адрес вида https://…".to_owned());
    }
    let authority = rest.split(['/', '?', '#', '\\']).next().unwrap_or_default();
    // `user:password@host`: only the host matters.
    let authority = authority.rsplit('@').next().unwrap_or_default();
    let authority = authority.to_ascii_lowercase();
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (authority.as_str(), None),
    };
    let host = host.trim_end_matches('.');
    let valid_host = !host.is_empty()
        && host
            .chars()
            .all(|char| char.is_ascii_alphanumeric() || char == '-' || char == '.')
        && !host.starts_with(['.', '-']);
    if !valid_host {
        return Err("Не похоже на адрес Outline".to_owned());
    }
    // Digits only: `u16::from_str` would take `+80` too.
    if let Some(port) = port
        && (port.is_empty()
            || !port.bytes().all(|byte| byte.is_ascii_digit())
            || port.parse::<u16>().is_err())
    {
        return Err("Не похоже на адрес Outline".to_owned());
    }
    if scheme == "http" && !LOCAL_HOSTS.contains(&host) {
        return Err("Нужен адрес с https".to_owned());
    }
    Ok(match port {
        Some(port) => format!("{scheme}://{host}:{port}"),
        None => format!("{scheme}://{host}"),
    })
}

#[cfg(test)]
mod tests {
    use super::normalize;

    #[test]
    fn cuts_any_address_to_its_root() {
        for (input, expected) in [
            ("wandry.getoutline.com", "https://wandry.getoutline.com"),
            (
                "  wandry.getoutline.com/  ",
                "https://wandry.getoutline.com",
            ),
            (
                "https://wandry.getoutline.com/",
                "https://wandry.getoutline.com",
            ),
            (
                "HTTPS://Wandry.GetOutline.com",
                "https://wandry.getoutline.com",
            ),
            // `outline-connector`, «Ссылка на документ».
            (
                "wandry.getoutline.com/doc/telemedia-brief-AbC123",
                "https://wandry.getoutline.com",
            ),
            (
                "https://wandry.getoutline.com/collection/telemedia-x1Y2z3/recent",
                "https://wandry.getoutline.com",
            ),
            (
                "https://docs.pixel.agency/search?query=api#top",
                "https://docs.pixel.agency",
            ),
            (
                "https://docs.pixel.agency:8443/doc/a",
                "https://docs.pixel.agency:8443",
            ),
            ("http://localhost:3000/doc/a", "http://localhost:3000"),
            ("http://127.0.0.1:8080", "http://127.0.0.1:8080"),
            ("http://localhost", "http://localhost"),
            (
                "https://user:pass@docs.pixel.agency/x",
                "https://docs.pixel.agency",
            ),
        ] {
            assert_eq!(normalize(input).as_deref(), Ok(expected), "{input}");
        }
    }

    #[test]
    fn refuses_plain_http_and_what_is_not_an_address() {
        // `outline-connector`, «Свой Outline по http».
        assert_eq!(
            normalize("http://docs.pixel.agency"),
            Err("Нужен адрес с https".to_owned())
        );
        assert_eq!(
            normalize("http://docs.pixel.agency/doc/x"),
            Err("Нужен адрес с https".to_owned())
        );
        assert_eq!(normalize("   "), Err("Введите адрес Outline".to_owned()));
        for input in [
            "ftp://docs.pixel.agency",
            "https://",
            "https:///doc",
            "docs pixel agency",
            "https://docs.pixel.agency:http",
            "https://docs.pixel.agency:99999",
            "https://docs.pixel.agency:+80",
            "docs.pixel.agency:-1",
            "docs.pixel.agency: 80",
            "-bad.example",
            // IPv6 literals are not taken (a self-hosted Outline has a name
            // or 127.0.0.1).
            "http://[::1]:3000",
            "https://[2001:db8::1]",
        ] {
            assert!(normalize(input).is_err(), "{input}");
        }
    }
}
