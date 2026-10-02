VERSION := $(shell node -p "require('./package.json').version")
VSIX := korn-extension-$(VERSION).vsix
KORN_VERSION := $(shell node -p "require('fs').readFileSync('daemon/version.ts','utf8').match(/'(.+)'/)[1]")
KORN_TGZ := dist/korn-$(KORN_VERSION).tar.gz

.PHONY: run test package install clean daemon-build daemon-run daemon-release korn-link korn-tag

# ---- VS Code extension ----

run:
	npm run compile && code --extensionDevelopmentPath="$(CURDIR)" --new-window

test:
	npm test

package:
	npm run package

install: package
	code --install-extension $(VSIX)

clean:
	rm -rf out dist *.vsix

# ---- korn daemon (daemon/, see docs/daemon.md) ----

# dist/korn.js: the CLI + daemon in one file
daemon-build:
	npm run daemon:build

# Run the daemon in this terminal with your real config (~/.config/korn/config.yaml); Ctrl+C to stop
daemon-run: daemon-build
	KORN_LOG_STDOUT=1 node dist/korn.js daemon

# Dev: put `korn` (this repo's dist/korn.js) in PATH instead of an alias
korn-link: daemon-build
	mkdir -p $(HOME)/.local/bin
	ln -sf "$(CURDIR)/dist/korn.js" $(HOME)/.local/bin/korn
	chmod +x dist/korn.js
	@echo "korn → $(CURDIR)/dist/korn.js  (needs ~/.local/bin in PATH)"

# Tarball + rendered formula (the release workflow runs this too, see docs/daemon.md "Releasing")
daemon-release: daemon-build
	rm -rf dist/korn-$(KORN_VERSION) && mkdir -p dist/korn-$(KORN_VERSION)
	cp dist/korn.js LICENSE dist/korn-$(KORN_VERSION)/
	tar -czf $(KORN_TGZ) -C dist korn-$(KORN_VERSION)
	rm -rf dist/korn-$(KORN_VERSION)
	node packaging/homebrew/render-formula.mjs $(KORN_VERSION) $$(shasum -a 256 $(KORN_TGZ) | cut -d' ' -f1) > dist/korn.rb
	@echo "$(KORN_TGZ) + dist/korn.rb"

# Prints the commands that publish korn $(KORN_VERSION) to Homebrew (GitHub Actions does the rest)
korn-tag:
	@echo "git tag korn-v$(KORN_VERSION) && git push origin korn-v$(KORN_VERSION)"
