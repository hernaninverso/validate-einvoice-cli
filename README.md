# @eleata/validate-einvoice

Validate **EU electronic invoices** (Peppol BIS, EN 16931, XRechnung, Factur-X/ZUGFeRD, UBL, CII)
in CI/CD — and get a **plain-English fix per error**, not just a rule id. Backed by
[eleata.io](https://eleata.io).

> Never ship a broken invoice. Fail the build with the rule id + the fix **before** a rejection
> (an SdI *scarto*, a Chorus Pro refusal, a KSeF error) ever happens.

## Quick start

```bash
# one-off, no install
npx @eleata/validate-einvoice validate invoice.xml --format auto --api-key $EINVOICE_API_KEY

# explain an error code (offline, no key)
npx @eleata/validate-einvoice explain 00400

# list supported formats
npx @eleata/validate-einvoice formats
```

Get a free API key (200 validations/month, no card) at <https://eleata.io/signup/>.

## Commands

| Command | What it does |
|---------|--------------|
| `validate <file...>` | Validate one or more invoices. Exit code `1` if any file fails (above `--fail-on`), `0` if all pass. `.pdf` is treated as Factur-X/ZUGFeRD. |
| `formats` | List the formats eleata validates today + roadmap. |
| `explain <rule-id>` | Explain an error code (e.g. `00400`, `BR-DE-21`) with the fix. Works offline. |

### `validate` flags

- `--format <fmt>` — `auto` (default) `peppol-bis-3` `en16931-ubl` `en16931-cii` `xrechnung-ubl` `xrechnung-cii` `factur-x` `ubl` `cii`
- `--api-key <key>` — or env `EINVOICE_API_KEY` / `ELEATA_API_KEY`
- `--fail-on <error|warning|never>` — severity that makes the command exit non-zero (default `error`)
- `--json` — emit machine-readable JSON instead of the human summary

## In CI

A ready-made GitHub Action is also available:
[`hernaninverso/validate-einvoice-action`](https://github.com/hernaninverso/validate-einvoice-action).
Or call the CLI directly:

```yaml
- run: npx @eleata/validate-einvoice validate "invoices/**/*.xml" --format auto
  env:
    EINVOICE_API_KEY: ${{ secrets.EINVOICE_API_KEY }}
```

## Privacy

`validate` sends the invoice to the hosted eleata API. `explain` is offline (the error-code
reference is bundled). See <https://eleata.io/privacy/>.

MIT licensed. Schematron engines: [Mustang](https://www.mustangproject.org/) /
[phive](https://github.com/phax/phive). Rules from CEN, OpenPeppol, KoSIT.
