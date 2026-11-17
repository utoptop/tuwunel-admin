use std::{path::PathBuf, time::Duration};
use tuwunel_admin::observability::{ObserverConfig, collect};
fn main() {
    if let Err(e) = run() {
        eprintln!("采集器启动失败：{e}");
        std::process::exit(1);
    }
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let mut path = PathBuf::from("observer.toml");
    let mut once = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--config" => path = args.next().ok_or("--config 需要文件路径")?.into(),
            "--once" => once = true,
            "--version" => {
                println!("tuwunel-observer {}", env!("CARGO_PKG_VERSION"));
                return Ok(());
            }
            _ => return Err("参数：--config observer.toml [--once]".into()),
        }
    }
    let text = std::fs::read_to_string(&path).map_err(|_| "无法读取采集器配置")?;
    let mut config: ObserverConfig =
        toml::from_str(&text).map_err(|_| "采集器 TOML 格式或字段无效")?;
    config.homeserver =
        tuwunel_admin::matrix::normalize(&config.homeserver).map_err(|_| "homeserver 地址无效")?;
    if !(1..=15).contains(&config.interval_seconds)
        || config.pid == 0
        || config.process_name.is_empty()
        || config.server_name.is_empty()
    {
        return Err("采集参数无效，周期须为 1–15 秒".into());
    }
    let parent = path.parent().unwrap_or(std::path::Path::new("."));
    for p in [&mut config.output_file, &mut config.proc_root]
        .into_iter()
        .chain(config.tuwunel_config.iter_mut())
        .chain(config.registration_log.iter_mut())
    {
        if p.is_relative() {
            *p = parent.join(&*p);
        }
    }
    #[cfg(target_os = "linux")]
    let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) } as f64;
    #[cfg(not(target_os = "linux"))]
    let ticks = 100.;
    if ticks <= 0. {
        return Err("无法确定 Linux CPU 时钟频率".into());
    }
    let mut previous = None;
    let mut history = Vec::new();
    loop {
        let (snapshot, counters) = collect(&config, previous.as_ref(), &mut history, ticks);
        previous = counters;
        let temporary = config.output_file.with_extension("tmp");
        std::fs::write(&temporary, serde_json::to_vec(&snapshot)?)
            .map_err(|_| "无法写入共享快照目录")?;
        std::fs::rename(&temporary, &config.output_file).map_err(|_| "无法原子替换快照")?;
        if once {
            break;
        }
        std::thread::sleep(Duration::from_secs(config.interval_seconds));
    }
    Ok(())
}
