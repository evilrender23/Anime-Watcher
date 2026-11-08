//! Resolución de nombres que resiste los bloqueos de las operadoras.
//!
//! En España las operadoras bloquean por orden judicial IPs de Cloudflare (sobre todo durante
//! los partidos de LaLiga) y algunos dominios por DNS. MonosChinos y varios servidores de video
//! están detrás de Cloudflare, que sirve cualquier web desde cualquiera de sus IPs. Así que:
//!
//! 1. Se pregunta a la vez al DNS del sistema y a Google por DNS cifrado (DoH), que la
//!    operadora no puede alterar.
//! 2. Si el sitio está en Cloudflare, se añaden otras IPs de Cloudflare de rangos distintos.
//! 3. Se prueban todas a la vez (conexión TCP al 443) y se pone primero la que antes conecta.
//!
//! El resultado se guarda unos minutos para no repetirlo en cada petición.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use serde::Deserialize;

const ESPERA_DNS: Duration = Duration::from_secs(4);
const ESPERA_PRUEBA: Duration = Duration::from_secs(3);
const VIGENCIA: Duration = Duration::from_secs(10 * 60);

/// IPs de Cloudflare de rangos distintos a los que suelen bloquearse (188.114.96.0/20,
/// 172.67.0.0/16…). Comprobadas sirviendo monoschinos.st.
const CLOUDFLARE_ALTERNATIVAS: [Ipv4Addr; 3] =
    [Ipv4Addr::new(104, 21, 0, 1), Ipv4Addr::new(104, 16, 0, 1), Ipv4Addr::new(104, 18, 0, 1)];

/// https://www.cloudflare.com/ips/
const CLOUDFLARE_V4: [(u32, u8); 15] = [
    (0xADF5_3000, 20), // 173.245.48.0/20
    (0x6715_F400, 22), // 103.21.244.0/22
    (0x6716_C800, 22), // 103.22.200.0/22
    (0x671F_0400, 22), // 103.31.4.0/22
    (0x8D65_4000, 18), // 141.101.64.0/18
    (0x6CA2_C000, 18), // 108.162.192.0/18
    (0xBE5D_F000, 20), // 190.93.240.0/20
    (0xBC72_6000, 20), // 188.114.96.0/20
    (0xC5EA_F000, 22), // 197.234.240.0/22
    (0xC629_8000, 17), // 198.41.128.0/17
    (0xA29E_0000, 15), // 162.158.0.0/15
    (0x6810_0000, 13), // 104.16.0.0/13
    (0x6818_0000, 14), // 104.24.0.0/14
    (0xAC40_0000, 13), // 172.64.0.0/13
    (0x8300_4800, 22), // 131.0.72.0/22
];
const CLOUDFLARE_V6: [(u128, u8); 7] = [
    (0x2400_cb00 << 96, 32),
    (0x2606_4700 << 96, 32),
    (0x2803_f800 << 96, 32),
    (0x2405_b500 << 96, 32),
    (0x2405_8100 << 96, 32),
    (0x2a06_98c0 << 96, 29),
    (0x2c0f_f248 << 96, 32),
];

pub fn es_cloudflare(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let n = u32::from(v4);
            CLOUDFLARE_V4.iter().any(|&(red, bits)| n >> (32 - bits) == red >> (32 - bits))
        }
        IpAddr::V6(v6) => {
            let n = u128::from(v6);
            CLOUDFLARE_V6.iter().any(|&(red, bits)| n >> (128 - bits) == red >> (128 - bits))
        }
    }
}

/// Candidatas sin repetir: primero las de DoH (fiables), luego las del sistema y, si el sitio
/// está en Cloudflare, las alternativas.
fn candidatas(doh: &[IpAddr], sistema: &[IpAddr]) -> Vec<IpAddr> {
    let mut ips: Vec<IpAddr> = Vec::new();
    for &ip in doh.iter().chain(sistema) {
        if !ips.contains(&ip) {
            ips.push(ip);
        }
    }
    if ips.iter().any(|&ip| es_cloudflare(ip)) {
        for ip in CLOUDFLARE_ALTERNATIVAS.map(IpAddr::V4) {
            if !ips.contains(&ip) {
                ips.push(ip);
            }
        }
    }
    ips
}

#[derive(Deserialize)]
struct RespuestaDoh {
    #[serde(rename = "Answer", default)]
    respuestas: Vec<RegistroDoh>,
}

#[derive(Deserialize)]
struct RegistroDoh {
    #[serde(rename = "type")]
    tipo: u16,
    data: String,
}

#[derive(Clone)]
pub struct Resolutor {
    doh: reqwest::Client,
    cache: Arc<Mutex<HashMap<String, (Instant, Vec<IpAddr>)>>>,
}

impl Resolutor {
    pub fn new() -> reqwest::Result<Self> {
        // dns.google por sus IPs fijas: no depende del DNS de la operadora.
        let google = [
            SocketAddr::new(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8)), 443),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::new(8, 8, 4, 4)), 443),
            SocketAddr::new(IpAddr::V6(Ipv6Addr::new(0x2001, 0x4860, 0x4860, 0, 0, 0, 0, 0x8888)), 443),
        ];
        let doh = reqwest::Client::builder()
            .resolve_to_addrs("dns.google", &google)
            .timeout(ESPERA_DNS)
            .build()?;
        Ok(Resolutor { doh, cache: Arc::default() })
    }

    async fn por_doh(&self, nombre: &str) -> Vec<IpAddr> {
        let peticion = self
            .doh
            .get("https://dns.google/resolve")
            .query(&[("name", nombre), ("type", "A")])
            .header("Accept", "application/dns-json");
        let Ok(respuesta) = peticion.send().await else { return Vec::new() };
        let Ok(datos) = respuesta.json::<RespuestaDoh>().await else { return Vec::new() };
        datos.respuestas.iter().filter(|r| r.tipo == 1).filter_map(|r| r.data.parse().ok()).collect()
    }

    async fn por_sistema(nombre: &str) -> Vec<IpAddr> {
        match tokio::time::timeout(ESPERA_DNS, tokio::net::lookup_host((nombre, 0))).await {
            Ok(Ok(addrs)) => addrs.map(|a| a.ip()).collect(),
            _ => Vec::new(),
        }
    }

    /// Prueba todas a la vez y pone primero la que antes conecta (sin esperar a las que no
    /// responden); el resto queda detrás en su orden, por si acaso.
    async fn ordenar_por_conexion(ips: Vec<IpAddr>) -> Vec<IpAddr> {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        for &ip in &ips {
            let tx = tx.clone();
            tokio::spawn(async move {
                let ok = matches!(
                    tokio::time::timeout(ESPERA_PRUEBA, tokio::net::TcpStream::connect((ip, 443))).await,
                    Ok(Ok(_))
                );
                let _ = tx.send((ip, ok));
            });
        }
        drop(tx);
        while let Some((ip, ok)) = rx.recv().await {
            if ok {
                let mut ordenadas = vec![ip];
                ordenadas.extend(ips.into_iter().filter(|&otra| otra != ip));
                return ordenadas;
            }
        }
        ips
    }

    pub async fn resolver(&self, nombre: &str) -> Vec<IpAddr> {
        if let Ok(ip) = nombre.parse::<IpAddr>() {
            return vec![ip];
        }
        if let Some((cuando, ips)) = self.cache.lock().unwrap().get(nombre) {
            if cuando.elapsed() < VIGENCIA {
                return ips.clone();
            }
        }
        let (doh, sistema) = tokio::join!(self.por_doh(nombre), Self::por_sistema(nombre));
        let mut ips = candidatas(&doh, &sistema);
        if ips.len() > 1 {
            ips = Self::ordenar_por_conexion(ips).await;
        }
        if !ips.is_empty() {
            self.cache.lock().unwrap().insert(nombre.to_owned(), (Instant::now(), ips.clone()));
        }
        ips
    }
}

impl Resolve for Resolutor {
    fn resolve(&self, name: Name) -> Resolving {
        let yo = self.clone();
        Box::pin(async move {
            let nombre = name.as_str().to_owned();
            let ips = yo.resolver(&nombre).await;
            if ips.is_empty() {
                return Err(format!("No se encontró la dirección de {nombre}.").into());
            }
            let addrs: Addrs = Box::new(ips.into_iter().map(|ip| SocketAddr::new(ip, 0)));
            Ok(addrs)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconoce_ips_de_cloudflare() {
        assert!(es_cloudflare("188.114.97.5".parse().unwrap()));
        assert!(es_cloudflare("104.21.0.1".parse().unwrap()));
        assert!(es_cloudflare("2a06:98c1:3120::5".parse().unwrap()));
        assert!(!es_cloudflare("8.8.8.8".parse().unwrap()));
        assert!(!es_cloudflare("2001:4860:4860::8888".parse().unwrap()));
    }

    #[test]
    fn alternativas_solo_para_cloudflare() {
        let cf: IpAddr = "188.114.96.5".parse().unwrap();
        let otra: IpAddr = "93.184.215.14".parse().unwrap();
        let c = candidatas(&[cf], &[cf]);
        assert_eq!(c[0], cf);
        assert_eq!(c.len(), 1 + CLOUDFLARE_ALTERNATIVAS.len());
        assert_eq!(candidatas(&[], &[otra]), vec![otra]);
    }

    /// Simula el bloqueo: la IP "oficial" no responde y aun así se llega a la web.
    /// `cargo test -- --ignored esquiva_bloqueo`
    #[tokio::test]
    #[ignore]
    async fn esquiva_bloqueo() {
        let bloqueada: IpAddr = "188.114.96.5".parse().unwrap();
        let inicio = Instant::now();
        let ordenadas = Resolutor::ordenar_por_conexion(vec![
            "10.255.255.1".parse().unwrap(), // no responde, como una IP bloqueada
            bloqueada,
            IpAddr::V4(CLOUDFLARE_ALTERNATIVAS[0]),
        ])
        .await;
        println!("{ordenadas:?} en {:?}", inicio.elapsed());
        assert!(inicio.elapsed() < ESPERA_PRUEBA);
        assert_ne!(ordenadas[0], "10.255.255.1".parse::<IpAddr>().unwrap());
        let r = Resolutor::new().unwrap();
        println!("doh monoschinos.st = {:?}", r.por_doh("monoschinos.st").await);
        println!("resolver = {:?}", r.resolver("monoschinos.st").await);
        // Petición real con el cliente de la app.
        let cliente = crate::http::scraper_client().unwrap();
        let pagina = crate::http::get_page(&cliente, "https://monoschinos.st/buscar?q=one+piece", None).await.unwrap();
        println!("búsqueda: {} bytes, {}", pagina.body.len(), pagina.body.to_lowercase().contains("one piece"));
        assert!(pagina.body.to_lowercase().contains("one piece"));
    }
}
