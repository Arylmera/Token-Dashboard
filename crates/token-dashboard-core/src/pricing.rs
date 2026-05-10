//! Pricing table + plan-aware cost computation.
//!
//! Direct port of `token_dashboard/pricing.py`. The pricing JSON lives at
//! `token_dashboard/pricing.json` and is shared with the 3.x runtime —
//! see plan §"Pricing data". To avoid a runtime FS dependency on that
//! exact path (it shifts under `crates/` builds), we `include_str!` the
//! file at compile time and expose an `embedded()` constructor; callers
//! that want to A/B a pricing tweak can layer overrides via
//! `apply_overrides`.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

const EMBEDDED_PRICING_JSON: &str = include_str!("../../../token_dashboard/pricing.json");

pub const PRICING_FIELDS: &[&str] = &[
    "input",
    "output",
    "cache_read",
    "cache_create_5m",
    "cache_create_1h",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelRates {
    #[serde(default)]
    pub tier: Option<String>,
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_create_5m: f64,
    pub cache_create_1h: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TierRates {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_create_5m: f64,
    pub cache_create_1h: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plan {
    pub monthly: f64,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Pricing {
    #[serde(default)]
    pub models: HashMap<String, ModelRates>,
    #[serde(default)]
    pub tier_fallback: HashMap<String, TierRates>,
    #[serde(default)]
    pub tier_weight: HashMap<String, f64>,
    #[serde(default)]
    pub plans: HashMap<String, Plan>,
}

impl Pricing {
    /// Pricing data baked into the binary at build time. This is the
    /// default the cli and any downstream caller should reach for.
    pub fn embedded() -> Self {
        serde_json::from_str(EMBEDDED_PRICING_JSON).expect("embedded pricing.json must parse")
    }

    pub fn from_file<P: AsRef<Path>>(path: P) -> Result<Self, std::io::Error> {
        let s = std::fs::read_to_string(path.as_ref())?;
        serde_json::from_str(&s)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
    }
}

/// Token usage for a single message or aggregation row.
#[derive(Debug, Clone, Copy, Default)]
pub struct Usage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_create_5m_tokens: i64,
    pub cache_create_1h_tokens: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CostBreakdown {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_create_5m: f64,
    pub cache_create_1h: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CostResult {
    /// `None` when no rates match. Matches python `cost_for` returning
    /// `{"usd": None, ...}`.
    pub usd: Option<f64>,
    pub estimated: bool,
    pub breakdown: Option<CostBreakdown>,
}

fn strip_date_suffix(model: &str) -> &str {
    // Python uses regex `-\d{8}$`. Equivalent: 9 trailing chars are `-` +
    // 8 digits.
    if model.len() <= 9 {
        return model;
    }
    let (head, tail) = model.split_at(model.len() - 9);
    let bytes = tail.as_bytes();
    if bytes[0] == b'-' && bytes[1..].iter().all(|b| b.is_ascii_digit()) {
        head
    } else {
        model
    }
}

fn tier_from_name(model: &str) -> Option<&'static str> {
    let lower = model.to_lowercase();
    ["opus", "sonnet", "haiku"]
        .into_iter()
        .find(|tier| lower.contains(tier))
}

/// Compute per-model usage cost. Mirrors `pricing.cost_for` line-for-line.
pub fn cost_for(model: &str, usage: &Usage, pricing: &Pricing) -> CostResult {
    let mut estimated = false;
    let rates: Option<TierRates> = if let Some(r) = pricing.models.get(model) {
        Some(model_to_tier_rates(r))
    } else {
        let stripped = strip_date_suffix(model);
        if stripped != model {
            pricing.models.get(stripped).map(model_to_tier_rates)
        } else {
            None
        }
    }
    .or_else(|| {
        let tier = tier_from_name(model)?;
        let r = pricing.tier_fallback.get(tier)?.clone();
        estimated = true;
        Some(r)
    });

    let Some(rates) = rates else {
        return CostResult {
            usd: None,
            estimated: true,
            breakdown: None,
        };
    };

    let bd = CostBreakdown {
        input: usage.input_tokens as f64 * rates.input / 1_000_000.0,
        output: usage.output_tokens as f64 * rates.output / 1_000_000.0,
        cache_read: usage.cache_read_tokens as f64 * rates.cache_read / 1_000_000.0,
        cache_create_5m: usage.cache_create_5m_tokens as f64 * rates.cache_create_5m / 1_000_000.0,
        cache_create_1h: usage.cache_create_1h_tokens as f64 * rates.cache_create_1h / 1_000_000.0,
    };
    let total = bd.input + bd.output + bd.cache_read + bd.cache_create_5m + bd.cache_create_1h;
    CostResult {
        usd: Some(round6(total)),
        estimated,
        breakdown: Some(bd),
    }
}

fn model_to_tier_rates(m: &ModelRates) -> TierRates {
    TierRates {
        input: m.input,
        output: m.output,
        cache_read: m.cache_read,
        cache_create_5m: m.cache_create_5m,
        cache_create_1h: m.cache_create_1h,
    }
}

fn round6(v: f64) -> f64 {
    (v * 1_000_000.0).round() / 1_000_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_loads() {
        let p = Pricing::embedded();
        assert!(p.models.contains_key("claude-opus-4-7"));
        assert!(p.tier_fallback.contains_key("sonnet"));
    }

    #[test]
    fn cost_for_opus_uses_table() {
        let p = Pricing::embedded();
        let r = cost_for(
            "claude-opus-4-7",
            &Usage {
                input_tokens: 1_000_000,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_create_5m_tokens: 0,
                cache_create_1h_tokens: 0,
            },
            &p,
        );
        assert!(!r.estimated);
        assert_eq!(r.usd, Some(5.0)); // $5/M input on opus-4-7
    }

    #[test]
    fn cost_for_unknown_model_with_tier_in_name_falls_back() {
        let p = Pricing::embedded();
        let r = cost_for(
            "claude-sonnet-9000-pre-release",
            &Usage {
                input_tokens: 1_000_000,
                ..Default::default()
            },
            &p,
        );
        assert!(r.estimated);
        assert!(r.usd.unwrap() > 0.0);
    }

    #[test]
    fn cost_for_completely_unknown_model_returns_none() {
        let p = Pricing::embedded();
        let r = cost_for(
            "gpt-9001",
            &Usage {
                input_tokens: 1_000_000,
                ..Default::default()
            },
            &p,
        );
        assert!(r.estimated);
        assert!(r.usd.is_none());
    }

    #[test]
    fn date_suffix_stripped() {
        assert_eq!(
            strip_date_suffix("claude-opus-4-7-20260214"),
            "claude-opus-4-7"
        );
        assert_eq!(strip_date_suffix("claude-opus-4-7"), "claude-opus-4-7");
        assert_eq!(strip_date_suffix("short"), "short");
    }
}
