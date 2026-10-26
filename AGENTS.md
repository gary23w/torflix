# Distribution material

Do not commit or push distribution channel material to this repository. Keep third-party
store listings, package-manager manifests, channel publishing scripts and workflows, and
submission notes in ignored local directories (such as `dist/`) or outside the checkout. Do not add
channel announcements or submission instructions to the README. Application source, native
build tools, and GitHub release build workflows belong in the repository.

# Local Windows searches

Do not invoke `rg`, `rg.exe`, or `ripgrep` on this computer. Use `git ls-files` with narrow
pathspecs, then bounded reads or `Select-String -LiteralPath` against an explicit, small
list of relevant text files. Never substitute an unbounded recursive scan, and keep search
concurrency to one. After a timeout or cancellation, verify child processes have exited
before retrying. Keep Windows Defender enabled and unchanged; do not add exclusions.
