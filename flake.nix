{
  description = "agenthost development and deployment tools";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    red-tape.url = "github:phaer/red-tape";
    red-tape.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    inputs:
    inputs.red-tape.mkFlake {
      inherit inputs;
      inherit (inputs) self;
      src = ./.;
      prefix = "nix";
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
    };
}
