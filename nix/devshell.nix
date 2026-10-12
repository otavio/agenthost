{ inputs, pkgs, ... }:

let
  libraries = pkgs.lib.makeLibraryPath [
    pkgs.stdenv.cc.cc
    pkgs.zlib
  ];
in
pkgs.mkShell (
  {
    packages = [
      inputs.pedantix.packages.${pkgs.stdenv.hostPlatform.system}.pedantix-wrapped
    ]
    ++ (with pkgs; [
      nodejs_24
      pnpm_10
      git
      curl
      jq
      direnv
      nixfmt
      shellcheck
    ]);
  }
  // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
    LD_LIBRARY_PATH = libraries;
    NIX_LD = pkgs.stdenv.cc.bintools.dynamicLinker;
    NIX_LD_LIBRARY_PATH = libraries;
  }
)
