# Homebrew formula for korn — TEMPLATE: {{version}} and {{sha256}} are filled in by
# packaging/homebrew/render-formula.mjs into Formula/korn.rb at the repo root, which is what
#   brew tap midnightzkkornz/korn https://github.com/midnightzkkornz/korn-extension
# reads. The release workflow (.github/workflows/korn-release.yml) does this after publishing to npm.
class Korn < Formula
  desc "Sync markdown notes through Git in the background"
  homepage "https://github.com/midnightzkkornz/korn-extension"
  # the same package as `npm install -g korn-sync`
  url "https://registry.npmjs.org/korn-sync/-/korn-sync-{{version}}.tgz"
  sha256 "{{sha256}}"
  license "MIT"

  depends_on "node"

  def install
    # one bundled file, no dependencies: no npm install needed
    libexec.install Dir["*"]
    (bin/"korn").write <<~EOS
      #!/bin/bash
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/korn.js" "$@"
    EOS
  end

  def caveats
    <<~EOS
      Set it up (a few questions, then it runs in the background):
        korn setup

      Then just type `korn` to see how it's doing. Stop it with `korn stop`.
      After `brew upgrade korn`, run `korn start` once to use the new version.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/korn --version")
    ENV["KORN_CONFIG"] = testpath/"config.yaml"
    system bin/"korn", "init"
    assert_path_exists testpath/"config.yaml"
  end
end
