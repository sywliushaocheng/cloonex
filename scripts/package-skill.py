#!/usr/bin/env python3
"""Package only public Cloonex skill files; no dependencies or user data."""

import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("work/skill-release"))
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    skill = root / "skills" / "cloonex"
    text = (skill / "SKILL.md").read_text(encoding="utf-8")
    match = re.search(r'^  version: "([0-9]+\.[0-9]+\.[0-9]+)"$', text, re.MULTILINE)
    if not match:
        raise SystemExit("Skill metadata.version is missing or invalid")
    version = match.group(1)
    # Explicit mapping prevents accidental inclusion of databases or local files.
    sources = {
        "cloonex/SKILL.md": skill / "SKILL.md",
        "cloonex/agents/openai.yaml": skill / "agents" / "openai.yaml",
        "cloonex/LICENSE": root / "LICENSE",
    }
    payloads = {}
    for name, source in sources.items():
        if source.is_symlink() or not source.is_file():
            raise SystemExit(f"Missing or symlinked public source: {source}")
        # Stable UTF-8 text and ZIP metadata across Windows and Linux checkouts.
        payloads[name] = source.read_text(encoding="utf-8").replace("\r\n", "\n").encode("utf-8")
    args.out.mkdir(parents=True, exist_ok=True)
    archive = args.out / f"cloonex-skill-{version}.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for name, payload in payloads.items():
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            bundle.writestr(info, payload)
    with zipfile.ZipFile(archive) as bundle:
        if bundle.namelist() != list(sources) or bundle.testzip() is not None:
            raise SystemExit("Skill archive validation failed")
        for name, payload in payloads.items():
            if bundle.read(name) != payload:
                raise SystemExit(f"Archive content mismatch: {name}")
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    checksum_file = args.out / f"cloonex-skill-{version}.sha256"
    checksum_file.write_text(f"{checksum}  {archive.name}\n", encoding="utf-8")
    print(json.dumps({"archive": str(archive.resolve()), "sha256": checksum,
                      "checksumFile": str(checksum_file.resolve()),
                      "files": list(sources)}, indent=2))


if __name__ == "__main__":
    main()
