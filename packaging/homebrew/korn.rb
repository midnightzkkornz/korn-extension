# Homebrew formula for korn — TEMPLATE: {{version}} and {{sha256}} are filled in by
# packaging/homebrew/render-formula.mjs, which the release workflow (.github/workflows/korn-release.yml)
# runs and pushes to github.com/midnightzkkornz/homebrew-tap as Formula/korn.rb.
class Korn < Formula
  desc "Sync markdown notes through Git in the background"
  homepage "https://github.com/midnightzkkornz/korn-extension"
  url "https://github.com/midnightzkkornz/korn-extension/releases/download/korn-v{{version}}/korn-{{version}}.tar.gz"
  sha256 "{{sha256}}"
  license "MIT"

  depends_on "node"

  def install
    libexec.install "korn.js"
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
      (korn start/stop manage the background service themselves; brew services isn't needed.)
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/korn --version")
    ENV["KORN_CONFIG"] = testpath/"config.yaml"
    system bin/"korn", "init"
    assert_path_exists testpath/"config.yaml"
  end
end
