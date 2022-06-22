#!/bin/sh
set -ex
ipfs config Addresses.Swarm '["/ip4/0.0.0.0/tcp/4001", "/ip4/0.0.0.0/tcp/8081/ws", "/ip6/::/tcp/4001"]' --json
ipfs config --bool Swarm.RelayService.Enabled true 
ipfs config --bool Swarm.EnableAutoNATService true
ipfs config --bool Swarm.RelayClient.Enabled true