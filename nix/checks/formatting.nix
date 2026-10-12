{
  flake,
  inputs,
  pkgs,
  ...
}:

(inputs.treefmt-nix.lib.evalModule pkgs {
  imports = [
    inputs.pedantix.treefmtModules.default
    ../treefmt.nix
  ];
}).config.build.check
  flake
