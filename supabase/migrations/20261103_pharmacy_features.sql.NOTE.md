Live uses the narrower migration `pharmacy_features_live_safe` (applied Nov 9): same columns, expiry alerts and expired-stock block,
but process_sale keeps live's own trading-hours logic and only gains the per-line dosage note.
Do NOT run 20261103_pharmacy_features.sql on live: its process_sale would drop trading hours and add stricter price/M-Pesa checks.
