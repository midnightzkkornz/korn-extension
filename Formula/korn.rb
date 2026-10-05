# Generated from packaging/homebrew/korn.rb by packaging/homebrew/render-formula.mjs: edit it there, not here.
class Korn < Formula
  desc "Sync markdown notes through Git in the background"
  homepage "https://github.com/midnightzkkornz/korn-extension"
  # the same package as `npm install -g korn-sync`
  url "https://registry.npmjs.org/korn-sync/-/korn-sync-0.1.1.tgz"
  sha256 "cbfd1afcc5b5c453eed2cf358ad2e18bdbf8e018b3d3eca2874b4db342ee1e1e"
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
