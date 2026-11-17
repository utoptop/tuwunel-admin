use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::PathBuf,
    time::Duration,
};
use tuwunel_admin::{
    app,
    config::Config,
    error::{AppError, Result},
    policy,
};

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("启动失败：{error}");
        std::process::exit(1);
    }
}
async fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let mut path = PathBuf::from("config.toml");
    let mut health = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--config" => {
                path = args
                    .next()
                    .map(PathBuf::from)
                    .ok_or_else(|| AppError::new(500, "--config 需要配置文件路径"))?;
            }
            "--health-check" => health = true,
            "--version" => {
                println!("tuwunel-admin {} (Rust)", env!("CARGO_PKG_VERSION"));
                return Ok(());
            }
            "--help" | "-h" => {
                println!("tuwunel-admin [--config config.toml] [--health-check] [--version]");
                return Ok(());
            }
            _ => return Err(AppError::new(500, "未知启动参数，请使用 --help")),
        }
    }
    let config = Config::load(&path)?;
    if health {
        let mut addr = config.server.listen;
        if addr.ip().is_unspecified() {
            addr.set_ip(match addr.ip() {
                IpAddr::V4(_) => IpAddr::V4(Ipv4Addr::LOCALHOST),
                IpAddr::V6(_) => IpAddr::V6(Ipv6Addr::LOCALHOST),
            });
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
            .map_err(|_| AppError::new(500, "健康检查初始化失败"))?;
        client
            .get(format!("http://{addr}/api/health"))
            .send()
            .await
            .map_err(|_| AppError::new(500, "健康检查连接失败"))?
            .error_for_status()
            .map_err(|_| AppError::new(500, "健康检查失败"))?;
        return Ok(());
    }
    let listener = tokio::net::TcpListener::bind(config.server.listen)
        .await
        .map_err(|_| AppError::new(500, "无法绑定监听地址"))?;
    let state = app::Inner::new(config)?;
    let maintenance = app::maintenance(state.clone());
    let scheduler = state
        .config
        .scheduler
        .enabled
        .then(|| policy::start(state.clone()));
    println!(
        "Tuwunel Admin {} (Rust) · http://{}",
        env!("CARGO_PKG_VERSION"),
        listener.local_addr().unwrap()
    );
    axum::serve(
        listener,
        app::router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await
    .map_err(|_| AppError::new(500, "HTTP 服务退出异常"))?;
    maintenance.abort();
    if let Some(scheduler) = scheduler {
        scheduler.abort();
    }
    Ok(())
}
async fn shutdown() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("signal handler");
        tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}}
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
