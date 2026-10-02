VERSION := $(shell node -p "require('./package.json').version")
VSIX := korn-extension-$(VERSION).vsix
KORN_VERSION := $(shell node -p "require('fs').readFileSync('daemon/version.ts','utf8').match(/'(.+)'/)[1]")

.PHONY: run test package install clean daemon-build daemon-run korn-link npm-build npm-pack npm-publish brew-formula brew-formula-check korn-tag

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

# ---- Publishing korn: npm (also pnpm/yarn/bun) + Homebrew formula in this repo (docs/daemon.md "Releasing") ----

# dist/npm: the korn-sync package
npm-build: daemon-build
	node packaging/npm/build.mjs

# What would be published
npm-pack: npm-build
	cd dist/npm && npm pack --dry-run

# Publish from this machine (needs `npm login`); the korn-release workflow does this on a korn-v* tag
npm-publish: npm-build
	cd dist/npm && npm publish --access public

# Formula/korn.rb from the version published on npm (run after npm-publish, then commit it)
brew-formula:
	curl -fsSL -o dist/korn-sync-$(KORN_VERSION).tgz https://registry.npmjs.org/korn-sync/-/korn-sync-$(KORN_VERSION).tgz
	mkdir -p Formula
	node packaging/homebrew/render-formula.mjs $(KORN_VERSION) $$(shasum -a 256 dist/korn-sync-$(KORN_VERSION).tgz | cut -d' ' -f1) > Formula/korn.rb
	@echo "Formula/korn.rb → korn-sync $(KORN_VERSION) (commit it)"

# Check the formula against a local pack, without publishing (writes dist/korn.rb, not Formula/)
brew-formula-check: npm-build
	cd dist/npm && npm pack --pack-destination .. >/dev/null
	node packaging/homebrew/render-formula.mjs $(KORN_VERSION) $$(shasum -a 256 dist/korn-sync-$(KORN_VERSION).tgz | cut -d' ' -f1) > dist/korn.rb
	ruby -c dist/korn.rb

# Prints the commands that release korn $(KORN_VERSION) (the workflow publishes to npm and updates Formula/)
korn-tag:
	@echo "git tag korn-v$(KORN_VERSION) && git push origin korn-v$(KORN_VERSION)"
