{
  description = "Torflix torrent streaming and downloads";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/3ec636362e1816bc2f0888fa0fa2c69f1bc9e504";

  outputs = { self, nixpkgs }: let
    system = "x86_64-linux";
    pkgs = import nixpkgs { inherit system; };
    torflix = pkgs.callPackage ./packaging/nix/package.nix { };
  in {
    packages.${system} = { inherit torflix; default = torflix; };
    apps.${system}.default = {
      type = "app";
      program = "${torflix}/bin/torflix";
    };
  };
}
