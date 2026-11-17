use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::json;
use std::net::IpAddr;
use tuwunel_admin::{
    catalog,
    config::Config,
    matrix::{normalize, public_ip},
    store::Store,
};

#[test]
fn config_enforces_lock_and_normalizes_origin() {
    let mut c = Config::default();
    c.matrix.locked = true;
    assert!(c.validate().is_err());
    c.matrix.homeserver = "HTTPS://Matrix.Example:443/".into();
    c.validate().unwrap();
    assert_eq!(c.matrix.homeserver, "https://matrix.example");
    assert!(c.select_homeserver(Some("https://other.example")).is_err());
    assert!(c.select_homeserver(None).unwrap().1);
    assert!(normalize("https://user:pass@example.org").is_err());
    assert!(normalize("https://example.org/api").is_err());
}
#[test]
fn public_network_filter_covers_mapped_and_special_addresses() {
    for ip in [
        "127.0.0.1",
        "10.1.2.3",
        "169.254.169.254",
        "100.64.0.1",
        "192.168.1.2",
        "172.31.1.1",
        "198.18.1.1",
        "0.0.0.0",
        "224.0.0.1",
        "::1",
        "::ffff:127.0.0.1",
        "64:ff9b::a00:1",
        "fe80::1",
        "fc00::1",
        "2001:db8::1",
        "2002:a00:1::",
    ] {
        assert!(!public_ip(ip.parse::<IpAddr>().unwrap()), "{ip}");
    }
    for ip in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
        assert!(public_ip(ip.parse().unwrap()), "{ip}");
    }
}
#[test]
fn catalog_allows_aliases_but_blocks_traversal_and_credentials() {
    let entries = catalog::catalog();
    assert_eq!(entries.len(), 73);
    let request = serde_json::from_value(
        json!({"id":"joinRoom","params":{"room_id_or_alias":"#lounge:example.org"},"confirm":true}),
    )
    .unwrap();
    assert_eq!(
        catalog::build(&entries["joinRoom"], &request).unwrap().1,
        "/_synapse/admin/v1/join/%23lounge%3Aexample.org"
    );
    for id in ["../evil", "%2e%2e", "x\\y", "x\n"] {
        let r = serde_json::from_value(json!({"id":"user","params":{"user_id":id}})).unwrap();
        assert!(catalog::build(&entries["user"], &r).is_err());
    }
}
#[test]
fn node_ciphertext_and_legacy_state_migrate_without_exposing_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = Config::default();
    c.storage.data_dir = dir.path().into();
    c.matrix.homeserver = "https://matrix.test".into();
    std::fs::write(dir.path().join("encryption.key"), [7u8; 32]).unwrap();
    let encrypted = "CQkJCQkJCQkJCQkJ1hwzujuRjxzNKi3HjUnvIkHs/ODLgqRM1A2gXYg=".replace(' ', "");
    let old = json!({"policy":{"enabled":true,"localDays":90,"remoteDays":30,"intervalHours":24,"sizeGt":0,"keepProfiles":true,"credential":encrypted,"owner":"@admin:matrix.test","homeserver":"https://matrix.test","nextRun":0},"audit":[{"actor":"@admin:matrix.test","action":"test"}]});
    std::fs::write(dir.path().join("state.json"), old.to_string()).unwrap();
    let store = Store::open(&c).unwrap();
    assert_eq!(store.unseal(&encrypted).unwrap(), "fixture-token");
    assert_eq!(store.data.schema_version, 2);
    assert_eq!(store.data.audit[0]["homeserver"], "https://matrix.test");
    assert!(dir.path().join("state.v1.backup.json").exists());
    assert_eq!(
        store.unseal(&store.seal("roundtrip").unwrap()).unwrap(),
        "roundtrip"
    );
    let mut tampered = STANDARD.decode(&encrypted).unwrap();
    tampered[20] ^= 1;
    assert!(store.unseal(&STANDARD.encode(tampered)).is_err());
    assert!(
        Store::open(&c).is_err(),
        "another process must not share this data directory"
    );
}
#[test]
fn toml_rejects_unknown_fields_and_invalid_limits() {
    assert!(toml::from_str::<Config>("[matrix]\nlockd=true").is_err());
    let mut c = Config::default();
    c.scheduler.poll_seconds = 0;
    assert!(c.validate().is_err());
    c = Config::default();
    c.server.public_url = "https://admin.example".into();
    assert!(c.validate().is_err());
    c.server.cookie_secure = true;
    assert!(c.validate().is_ok());
}
