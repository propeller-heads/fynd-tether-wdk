# Security

## Reporting

A private disclosure contact is not yet confirmed. Use an existing private PropellerHeads contact to arrange a report. Keep vulnerabilities, seeds, keys, RPC credentials and exploit payloads out of public issues and the [support group](https://t.me/+B4CNQwv7dgIyYTJl), which handles non-sensitive API support.

Include package/WDK versions, chain, public transaction hashes and a minimal reproduction with secrets removed.

## Integration precautions

- Keep API keys on a trusted backend or proxy; send the raw key in `Authorization`. A self-hosted Fynd needs no key.
- Bind the WDK account and provider to the module's chain. WDK owns keys, signing and broadcast; the module signs only the swap's client-fee parameters, through the account.
- Preserve transaction hashes and reconcile uncertain RPC submissions before retrying. Earlier approvals survive later failures.
- Avoid logging request configuration or upstream error causes. The library adds no logging or telemetry.

Read the [fee limits](README.md#fees-and-failures) and [router details](docs/compatibility.md#router-contract).
