/**
 * KKU OAS Borrowing System - Background Mail Gateway Re-export
 * Runtime: Node.js (CLI / Worker)
 * 
 * Re-exports dispatcher functions from functions/mail-gateway.mjs to maintain
 * a single source of truth across Cloud Functions and background worker scripts.
 */

export {
  isMockGatewayAllowed,
  dispatchViaGateway,
} from '../functions/mail-gateway.mjs';
