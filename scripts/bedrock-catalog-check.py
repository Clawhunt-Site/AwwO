"""Compare apps/bedrock-models.json with what the AWS account can see. Read-only.

    python scripts/bedrock-catalog-check.py --region us-east-1 [--profile NAME]

Lists foundation models and inference profiles (no inference, no cost) and reports every
catalog target that is missing, not ACTIVE, or not invocable the way the catalog names it
(an in-region model id needs ON_DEMAND; a global./us. target needs that system profile).
Exits 1 when a catalog entry needs attention. Requires boto3 and
bedrock:ListFoundationModels / bedrock:ListInferenceProfiles.
"""
import argparse
import json
import pathlib
import sys

CATALOG = pathlib.Path(__file__).resolve().parent.parent / "apps" / "bedrock-models.json"
PREFIXES = ("global.", "us.", "eu.", "apac.", "jp.", "au.", "ca.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--profile")
    args = parser.parse_args()
    import boto3

    session = boto3.Session(profile_name=args.profile) if args.profile else boto3.Session()
    bedrock = session.client("bedrock", region_name=args.region)
    models = {m["modelId"]: m for m in bedrock.list_foundation_models()["modelSummaries"]}
    profiles, token = set(), None
    while True:
        page = bedrock.list_inference_profiles(maxResults=1000, **({"nextToken": token} if token else {}))
        profiles.update(p["inferenceProfileId"] for p in page.get("inferenceProfileSummaries", []))
        token = page.get("nextToken")
        if not token:
            break
    problems = 0
    for entry in json.loads(CATALOG.read_text(encoding="utf-8"))["models"]:
        target = entry["target"]
        base = next((target[len(p):] for p in PREFIXES if target.startswith(p)), target)
        model = models.get(base)
        if model is None:
            issue = "model is not listed in this region"
        elif (model.get("modelLifecycle") or {}).get("status") != "ACTIVE":
            issue = f"model lifecycle is {(model.get('modelLifecycle') or {}).get('status')}"
        elif target != base and target not in profiles:
            issue = "inference profile is not listed"
        elif target == base and "ON_DEMAND" not in (model.get("inferenceTypesSupported") or []):
            issue = "model needs an inference profile; use its global./us. id"
        else:
            issue = ""
        if issue:
            problems += 1
        print(f"{'!!' if issue else 'ok'} {entry['id']:30} {target:52} {issue}")
    print(f"{problems} catalog entr{'y needs' if problems == 1 else 'ies need'} attention in {args.region}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
