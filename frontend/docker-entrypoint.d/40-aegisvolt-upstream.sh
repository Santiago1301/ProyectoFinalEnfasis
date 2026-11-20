#!/bin/sh
# Genera /tmp/upstream.conf con el DNS del clúster y el FQDN del gateway de
# ESTE namespace (primer dominio "search" de resolv.conf). Así nginx resuelve
# el upstream en cada petición y no se cae si arranca antes que CoreDNS.
set -eu
ns="$(awk '/^nameserver/ { print $2; exit }' /etc/resolv.conf)"
domain="$(awk '/^search/ { print $2; exit }' /etc/resolv.conf)"
case "$ns" in *:*) ns="[$ns]" ;; esac
host="graphql-gateway${domain:+.$domain}"
printf 'resolver %s valid=10s ipv6=off;\nset $gateway_host "%s";\n' "$ns" "$host" > /tmp/upstream.conf
echo "aegisvolt: upstream graphql-gateway -> $host (DNS $ns)"
