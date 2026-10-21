//! ONNX Runtime allows only one environment per process, so both offline models share this
//! one, created the first time either model loads.

use std::path::Path;
use std::sync::OnceLock;

use ort::environment::Environment;

static ENVIRONMENT: OnceLock<Environment> = OnceLock::new();

pub fn environment(library: &Path) -> Result<&'static Environment, String> {
    if let Some(env) = ENVIRONMENT.get() {
        return Ok(env);
    }
    let env = ort::init_from(library)
        .map_err(|e| e.to_string())?
        .with_name("qalam")
        .build()
        .map_err(|e| e.to_string())?;
    Ok(ENVIRONMENT.get_or_init(|| env))
}
