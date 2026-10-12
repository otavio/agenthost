{
  description = "agenthost development and deployment tools";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    pedantix.inputs.nixpkgs.follows = "nixpkgs";
    pedantix.inputs.treefmt-nix.follows = "treefmt-nix";
    pedantix.url = "github:Swarsel/pedantix";
    red-tape.inputs.nixpkgs.follows = "nixpkgs";
    red-tape.url = "github:phaer/red-tape";
    treefmt-nix.inputs.nixpkgs.follows = "nixpkgs";
    treefmt-nix.url = "github:numtide/treefmt-nix";
  };

  outputs =
    inputs:
    inputs.red-tape.mkFlake {
      inherit inputs;
      inherit (inputs) self;
      prefix = "nix";
      src = ./.;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
    };
}
