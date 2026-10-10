//! Production OMS order PRE-FLIGHT ONLY. Makes dangerous assumptions explicit
//! before a separately licensed & reconciled broker adapter could ever route.
//! There is deliberately no live Upstox POST in QSYN's public app or daemon.
use serde::{Deserialize, Serialize};
use std::io;

fn blocked() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "live_order_routing_not_authorized")
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionApproval {
    pub tenant: String, pub account: String, pub owner: String,
    pub broker: String, pub license_id: String,
    pub max_order_notional: f64,
    pub available_funds: f64,
    pub max_daily_loss: f64,
    pub observed_daily_loss: f64,
    pub max_net_contracts: u32,
    pub active_net_contracts: u32,
    pub max_tick_age_ms: u64,
    pub approval_expires_ms: u64,
    pub broker_session_verified: bool,
    pub reconciled_positions_verified: bool,
    pub exchange_algo_approval_verified: bool,
    pub human_execution_approval_verified: bool,
    pub kill_switch: bool,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProposedOrder {
    pub tenant: String, pub account: String, pub owner: String,
    pub instrument_key: String, pub side: String, pub product: String,
    pub order_type: String, pub quantity: u32, pub lot_size: u32,
    pub limit_price: f64, pub tick_price: f64,
    pub tick_time_ms: u64, pub requested_ms: u64,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct DryRunDecision {
    pub accepted_for_risk_review: bool,
    pub broker_submit_enabled: bool,
    pub reason: &'static str,
}
/// Prepares a deliberately **non-routable** reviewer-only decision.
/// Orders cannot be submitted even when every value is present and valid.
pub fn review_live_readiness(approval: &ExecutionApproval, order: &ProposedOrder)
    -> io::Result<DryRunDecision>
{
    if approval.kill_switch || !approval.human_execution_approval_verified
        || !approval.broker_session_verified || !approval.reconciled_positions_verified
        || !approval.exchange_algo_approval_verified || approval.broker != "upstox"
        || approval.license_id.is_empty()
        || approval.tenant != order.tenant || approval.account != order.account
        || approval.owner != order.owner || approval.approval_expires_ms <= order.requested_ms
        || order.requested_ms < order.tick_time_ms
        || order.requested_ms - order.tick_time_ms > approval.max_tick_age_ms
        || approval.max_tick_age_ms > 5_000
        || order.quantity == 0 || order.lot_size == 0
        || order.quantity % order.lot_size != 0
        || order.quantity > approval.max_net_contracts
        || approval.active_net_contracts > approval.max_net_contracts - order.quantity
        || order.side != "BUY" && order.side != "SELL"
        || order.product != "D" || order.order_type != "LIMIT"
        || !order.instrument_key.starts_with("NSE_FO|")
        || !order.instrument_key["NSE_FO|".len()..].bytes().all(|b| b.is_ascii_digit())
        || order.instrument_key.len() > 32
        || !order.limit_price.is_finite() || order.limit_price <= 0.0
        || !order.tick_price.is_finite() || order.tick_price <= 0.0
        || !approval.max_order_notional.is_finite() || approval.max_order_notional <= 0.0
        || !approval.available_funds.is_finite() || approval.available_funds <= 0.0
        || !approval.max_daily_loss.is_finite() || approval.max_daily_loss <= 0.0
        || !approval.observed_daily_loss.is_finite() || approval.observed_daily_loss < 0.0
        || approval.observed_daily_loss >= approval.max_daily_loss
        || order.limit_price * f64::from(order.quantity)
            > approval.max_order_notional.min(approval.available_funds)
        || ((order.limit_price / order.tick_price) - 1.0).abs() > 0.10
    { return Err(blocked()); }
    Ok(DryRunDecision {
        accepted_for_risk_review: true,
        broker_submit_enabled: false,
        reason: "manual_reconciliation_and_final_operator_signoff_required",
    })
}

/// Not a configuration toggle. Introducing real order submission requires a
/// separately reviewed provider adapter, fail-safe idempotency, observed fills,
/// cancellation/reconciliation and broker/exchange approvals.
pub fn submit_live_order_disabled(_order: &ProposedOrder) -> io::Result<()> {
    Err(blocked())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn approved() -> ExecutionApproval {
        ExecutionApproval {
            tenant:"T".into(),account:"A".into(),owner:"U".into(),
            broker:"upstox".into(),license_id:"L".into(),
            max_order_notional:10_000.0,available_funds:20_000.0,
            max_daily_loss:1_000.0,observed_daily_loss:100.0,
            max_net_contracts:100,active_net_contracts:0,
            max_tick_age_ms:2_000,approval_expires_ms:200_000,
            broker_session_verified:true,reconciled_positions_verified:true,
            exchange_algo_approval_verified:true,
            human_execution_approval_verified:true,kill_switch:false,
        }
    }
    fn order() -> ProposedOrder {
        ProposedOrder { tenant:"T".into(),account:"A".into(),owner:"U".into(),
            instrument_key:"NSE_FO|12345".into(),side:"BUY".into(),
            product:"D".into(),order_type:"LIMIT".into(),quantity:25,lot_size:25,
            limit_price:100.0,tick_price:99.0,tick_time_ms:99_000,
            requested_ms:100_000 }
    }
    #[test]fn strict_risk_preflight_can_never_place_live_orders() {
        let a=approved();let o=order();
        assert!(!review_live_readiness(&a,&o).unwrap().broker_submit_enabled);
        assert!(submit_live_order_disabled(&o).is_err());
        let mut x=a.clone();x.kill_switch=true;
        assert!(review_live_readiness(&x,&o).is_err());
        let mut x=a.clone();x.reconciled_positions_verified=false;
        assert!(review_live_readiness(&x,&o).is_err());
        let mut x=a.clone();x.observed_daily_loss=1_100.0;
        assert!(review_live_readiness(&x,&o).is_err());
        let mut x=o.clone();x.account="other".into();
        assert!(review_live_readiness(&a,&x).is_err());
        let mut x=o.clone();x.quantity=26;
        assert!(review_live_readiness(&a,&x).is_err());
        let mut x=o;x.tick_time_ms=80_000;
        assert!(review_live_readiness(&a,&x).is_err());
    }
}
