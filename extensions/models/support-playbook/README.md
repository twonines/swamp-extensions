# support-playbook

A swamp model that keeps routing rules for Cloud Ops support requests in the
swamp datastore. A rule says who owns a kind of ticket and what to do about it. Every
person who uses the same datastore reads the same rules.

## Set up the datastore

This model stores the rules in the swamp datastore of the repository that runs
it. Cloud Ops keeps the rules in the namespace `cloudops`. Each person must
scope the datastore of their repository to that namespace. Do this step before
the first run. Without it, the rules go to a different namespace and other
people do not see them.

```bash
swamp datastore setup extension @swamp/s3-datastore \
  --namespace cloudops \
  --config '{"bucket": "jw-cd-swamp-datastore", "prefix": "swamp", "region": "us-east-1"}'
swamp datastore status
```

The file `.swamp.yaml` must now show `namespace: cloudops` under `datastore`.
If the file shows a different namespace, the rules are not shared. The method
`add_rules` fails with an error in that case.

## Create the model

```bash
swamp extension pull @twonines/support-playbook
swamp model create @twonines/support-playbook support-playbook
```

## Add rules

Put the rules in a JSON file. Adding a rule with an existing `id` replaces that
rule.

```json
{
  "rules": [
    {
      "id": "device-names",
      "rule": "Device names belong to the device owner. Send the requester to the owner.",
      "why": "Example ticket about a renamed firewall"
    }
  ]
}
```

```bash
swamp model method run support-playbook add_rules --input-file rules.json
```

## Read the rules in a workflow

Use a CEL expression. The example builds one line for each rule.

```yaml
prompt: >-
  ${{ data.latest("support-playbook", "rules").attributes.rules
      .map(r, "- " + r.rule).join("\n") }}
```

The data item `rules` holds the list in `rules` and the time of the last change
in `updatedAt`. The datastore keeps the last 20 versions.
