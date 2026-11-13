import {
  getSolanaErrorFromTransactionError, isSolanaError,
  SOLANA_ERROR__TRANSACTION_ERROR__UNKNOWN, SOLANA_ERROR__INSTRUCTION_ERROR__UNKNOWN,
} from "@solana/kit";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const index = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;

/** A provider's arbitrary non-null JSON is not proof of failed execution. Keep
 * unknown SDK variants and malformed payloads UNKNOWN. */
export function validV2ErrorJson(raw: unknown): raw is string {
  if (typeof raw !== "string" || !raw.length || raw.length > 2048) return false;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "string") {
      if (!object(value) || Object.keys(value).length !== 1) return false;
      if ("InstructionError" in value) {
        const parts = value.InstructionError;
        if (!Array.isArray(parts) || parts.length !== 2 || !index(parts[0])) return false;
        const error = parts[1];
        if (typeof error !== "string" && !(object(error) && Object.keys(error).length === 1 && typeof error.Custom === "number"
          && Number.isInteger(error.Custom) && error.Custom >= 0 && error.Custom <= 0xffff_ffff)) return false;
      } else if ("DuplicateInstruction" in value) {
        if (!index(value.DuplicateInstruction)) return false;
      } else {
        const detail = value.InsufficientFundsForRent ?? value.ProgramExecutionTemporarilyRestricted;
        if (!object(detail) || Object.keys(detail).length !== 1 || !index(detail.account_index)) return false;
      }
    }
    const error = getSolanaErrorFromTransactionError(value);
    return !isSolanaError(error, SOLANA_ERROR__TRANSACTION_ERROR__UNKNOWN) && !isSolanaError(error, SOLANA_ERROR__INSTRUCTION_ERROR__UNKNOWN);
  } catch { return false; }
}
