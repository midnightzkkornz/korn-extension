VERSION := $(shell node -p "require('./package.json').version")
VSIX := korn-extension-$(VERSION).vsix

.PHONY: run test package install clean

run:
	npm run compile && code --extensionDevelopmentPath="$(CURDIR)" --new-window

test:
	npm test

package:
	npm run package

install: package
	code --install-extension $(VSIX)

clean:
	rm -rf out *.vsix
