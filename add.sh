#!/bin/bash

# Array of packages with their local paths
declare -A packages=(
  ["@comunica/actor-http-fetch"]="../../comunica/comunica/packages/actor-http-fetch"
  ["@comunica/actor-http-proxy"]="../../comunica/comunica/packages/actor-http-proxy"
  ["@comunica/actor-rdf-parse-html"]="../../comunica/comunica/packages/actor-rdf-parse-html"
  ["@comunica/actor-rdf-parse-html-microdata"]="../../comunica/comunica/packages/actor-rdf-parse-html-microdata"
  ["@comunica/actor-rdf-parse-html-rdfa"]="../../comunica/comunica/packages/actor-rdf-parse-html-rdfa"
  ["@comunica/actor-rdf-parse-html-script"]="../../comunica/comunica/packages/actor-rdf-parse-html-script"
  ["@comunica/actor-rdf-parse-jsonld"]="../../comunica/comunica/packages/actor-rdf-parse-jsonld"
  ["@comunica/actor-rdf-parse-n3"]="../../comunica/comunica/packages/actor-rdf-parse-n3"
  ["@comunica/actor-rdf-parse-rdfxml"]="../../comunica/comunica/packages/actor-rdf-parse-rdfxml"
  ["@comunica/actor-rdf-parse-shaclc"]="../../comunica/comunica/packages/actor-rdf-parse-shaclc"
  ["@comunica/actor-rdf-parse-xml-rdfa"]="../../comunica/comunica/packages/actor-rdf-parse-xml-rdfa"
  ["@comunica/bus-http"]="../../comunica/comunica/packages/bus-http"
  ["@comunica/bus-init"]="../../comunica/comunica/packages/bus-init"
  ["@comunica/bus-rdf-parse"]="../../comunica/comunica/packages/bus-rdf-parse"
  ["@comunica/bus-rdf-parse-html"]="../../comunica/comunica/packages/bus-rdf-parse-html"
  ["@comunica/config-query-sparql"]="../../comunica/comunica/engines/config-query-sparql"
  ["@comunica/core"]="../../comunica/comunica/packages/core"
  ["@comunica/mediator-combine-pipeline"]="../../comunica/comunica/packages/mediator-combine-pipeline"
  ["@comunica/mediator-combine-union"]="../../comunica/comunica/packages/mediator-combine-union"
  ["@comunica/mediator-number"]="../../comunica/comunica/packages/mediator-number"
  ["@comunica/mediator-race"]="../../comunica/comunica/packages/mediator-race"
)

# Loop through each package and run yarn add with the local path
for package in "${!packages[@]}"; do
  yarn add "$package@file:${packages[$package]}"
done
