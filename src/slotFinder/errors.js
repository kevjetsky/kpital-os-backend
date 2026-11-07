// An error the Slot Finder answers with a set HTTP status and a plain message:
// 400 bad input or address, 403 wrong account, 502 Google failed, 503 a
// required environment variable is missing.
export class SlotFinderError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "SlotFinderError";
    this.status = status;
  }
}

export const BAD_ADDRESS_MESSAGE = "Address not found or unreachable. Check the spelling and try again.";

export function missingEnv(name) {
  return new SlotFinderError(`${name} is not set. Add it to the backend environment.`, 503);
}
