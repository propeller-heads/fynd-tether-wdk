// Copyright 2026 PropellerHeads AG

// A Bare app that imports ethers and WDK itself loads its code with Node's import map, as bare.js does.
import 'bare-node-runtime/global'
import './runtime-swidge.mjs' with { imports: 'bare-node-runtime/imports' }
