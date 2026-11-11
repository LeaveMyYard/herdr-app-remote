// The RFC 6902 engine lives in the protocol package, so the PWA applies patches with the same code the hub diffs them with.
export { diff, applyPatch, PatchError, type Json } from "@herdr-remote/protocol";
