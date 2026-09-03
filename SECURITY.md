# Security

Never commit Contentful tokens or reuse production credentials with this
example. Keep `.env` local, use a disposable test environment, and review every
generated changeset before applying it. Attest the exact host, space, and
environment for each credential. Use separate read-only delivery, preview
management, preview API, production delivery, production-management read, and
production-management write credentials with the least privileges required for
one authorized phase. Do not make the write credential available to production
preparation.

`npm run check` is credential-free. Its Node preload denies common outbound
APIs and tightly controls child processes in-process; it is a defense-in-depth
test guard, not an operating-system network sandbox. Run untrusted changes in
an OS- or container-level sandbox as well. Live sync, apply, review, prepare,
execution, and close are independent operator-authorized actions.

Report a vulnerability through GitHub private vulnerability reporting: open
the repository's **Security → Advisories → Report a vulnerability** form. Do
not open a public issue. A distributor that disables GitHub private reporting
must replace this paragraph with an equally concrete private route before
publishing a release.
