package app

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode"
)

// What the registry decides of an imported skill's license (skill_registry_license.go), and what a preview's hash
// covers, with the stand-ins of skill_registry_test.go.

const mitText = "MIT License\n\nCopyright (c) 2026 Example Corporation. All rights reserved.\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software ... The above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n"

// Excerpts of real license texts whose words also name what other terms forbid.
const gplText = "\t\t    GNU GENERAL PUBLIC LICENSE\n\t\t       Version 2, June 1991\n\n ... (This alternative is allowed only for noncommercial distribution and only if you\nreceived the program in object code or executable form ...)\n ... This General Public License does not permit incorporating your program into\nproprietary programs.\n"
const unlicenseText = "This is free and unencumbered software released into the public domain.\n\nAnyone is free to copy, modify, publish, use, compile, sell, or\ndistribute this software, either in source code form or as a compiled\nbinary, for any purpose, commercial or non-commercial, and by any\nmeans.\n"

func TestRegistryLicenseIsOpenOnlyWhenTheSkillOrItsRepositorySaysSo(t *testing.T) {
	repo := func(license string) registryRepository {
		return registryRepository{Checked: true, Found: true, License: license}
	}
	skill := func(frontmatter string) string { return "---\nname: a\n" + frontmatter + "---\nDo the thing.\n" }
	for name, c := range map[string]struct {
		markdown string
		files    []string
		repo     registryRepository
		status   string
		spdx     string
	}{
		"declared MIT":                       {skill("license: MIT\n"), nil, registryRepository{}, "open", "MIT"},
		"declared long name":                 {skill("license: Apache License, Version 2.0\n"), nil, registryRepository{}, "open", "Apache-2.0"},
		"declared unlicense":                 {skill("license: The Unlicense\n"), nil, registryRepository{}, "open", "Unlicense"},
		"British spelling":                   {skill("licence: MIT\n"), nil, registryRepository{}, "open", "MIT"},
		"a list of one":                      {skill("license:\n  - MIT\n"), nil, registryRepository{}, "open", "MIT"},
		"repository MIT":                     {skill(""), nil, repo("MIT"), "open", "MIT"},
		"repository BSD":                     {skill(""), nil, repo("BSD-3-Clause"), "open", "BSD-3-Clause"},
		"repository copyleft":                {skill(""), nil, repo("GPL-3.0"), "unknown", ""},
		"repository CC BY-SA":                {skill(""), nil, repo("CC-BY-SA-4.0"), "unknown", ""},
		"repository unclassified":            {skill(""), nil, repo("NOASSERTION"), "unknown", ""},
		"no license file":                    {skill(""), nil, repo(""), "unknown", ""},
		"repository not checked":             {skill(""), nil, registryRepository{}, "unknown", ""},
		"repository missing":                 {skill(""), nil, registryRepository{Checked: true}, "unknown", ""},
		"declared but unrecognized":          {skill("license: Complete terms in LICENSE.txt\n"), nil, repo("MIT"), "unknown", ""},
		"declared as a mapping":              {skill("license:\n  name: MIT\n  url: https://example.test\n"), nil, repo("MIT"), "unknown", ""},
		"a list that disagrees":              {skill("license:\n  - MIT\n  - Apache-2.0\n"), nil, repo("MIT"), "unknown", ""},
		"declared proprietary":               {skill("license: Proprietary. LICENSE.txt has complete terms\n"), nil, repo("MIT"), "restricted", ""},
		"proprietary under another spelling": {skill("License: Proprietary\n"), nil, repo("MIT"), "restricted", ""},
		"proprietary in a list":              {skill("license:\n  - MIT\n  - Proprietary\n"), nil, repo("MIT"), "restricted", ""},
		"proprietary on a following line":    {skill("license: >\n  Proprietary; see LICENSE.txt\n"), nil, repo("MIT"), "restricted", ""},
		"a duplicate key keeps its value":    {skill("license: MIT\nlicense: Proprietary\n"), nil, repo("MIT"), "restricted", ""},
		"nested and forbidding":              {skill("metadata:\n  license: Proprietary\n"), nil, repo("MIT"), "restricted", ""},
		"nested and permissive never opens":  {skill("metadata:\n  asset:\n    license: MIT\n"), nil, repo("NOASSERTION"), "unknown", ""},
		"declared beside a nested license":   {skill("license: MIT\nmetadata:\n  license: Apache-2.0\n"), nil, repo("MIT"), "unknown", ""},
		"all rights reserved in the body":    {"---\nname: a\nlicense: MIT\n---\nCopyright 2026 Acme. All rights reserved.\n", nil, repo("MIT"), "unknown", ""},
		"license terms in the body":          {"---\nname: a\n---\nCheck that a dependency is not under a proprietary license.\n", nil, repo("MIT"), "unknown", ""},
		"a body that speaks of private code": {"---\nname: a\n---\nNever paste proprietary code or confidential data into prompts.\n", nil, repo("MIT"), "open", "MIT"},
		"own license file":                   {skill("license: MIT\n"), []string{"LICENSE", mitText}, repo("MIT"), "unknown", ""},
		"own license file with an id":        {skill(""), []string{"LICENSE-MIT", mitText}, repo("MIT"), "unknown", ""},
		"own file forbids reuse":             {skill("license: MIT\n"), []string{"LICENSE", "Proprietary terms: ask first."}, registryRepository{}, "restricted", ""},
		"a rider on a known license":         {skill(""), []string{"LICENSE", mitText + "\nNot for commercial use; non-commercial only.\n"}, repo("MIT"), "restricted", ""},
		"an end-user agreement":              {skill(""), []string{"EULA.txt", "End user terms."}, repo("MIT"), "unknown", ""},
		"a notice that only credits":         {skill(""), []string{"NOTICE", "This product includes software by Example."}, repo("Apache-2.0"), "open", "Apache-2.0"},
		"a notice that keeps all rights":     {skill(""), []string{"NOTICE", "Copyright Example, Inc. or its affiliates. All Rights Reserved."}, repo("Apache-2.0"), "unknown", ""},
		"a notice that forbids":              {skill(""), []string{"NOTICE", "Proprietary and confidential."}, repo("MIT"), "restricted", ""},
		"a nested license is the asset's":    {skill(""), []string{"fonts/LICENSE", "Proprietary."}, repo("MIT"), "open", "MIT"},
		"a license header is not a license":  {skill(""), []string{"license-header.txt", "/* Copyright X */"}, repo("MIT"), "open", "MIT"},
		"more notices than are read": {skill(""), []string{"NOTICE", "Credits.", "NOTICE.md", "Credits.", "NOTICE.txt", "Credits.", "COPYRIGHT", "Credits.", "COPYRIGHT.md", "Credits.", "COPYRIGHTS", "Credits."},
			repo("MIT"), "unknown", ""},
		// Any name a license file goes by is read, so its terms are seen and hashed; headers, templates and code are not.
		"a license file with its own suffix":  {skill(""), []string{"LICENSE-COMMERCIAL.md", "Proprietary terms: a license is required."}, repo("MIT"), "restricted", ""},
		"a license file named in words":       {skill(""), []string{"License (Proprietary).txt", "Ask Acme before any use."}, repo("MIT"), "unknown", ""},
		"a license that is not text":          {skill(""), []string{"EULA.pdf", "%PDF-1.7 binary"}, repo("MIT"), "unknown", ""},
		"a license page":                      {skill(""), []string{"LICENSE.html", "<p>Terms of Acme</p>"}, repo("MIT"), "unknown", ""},
		"a license folder":                    {skill(""), []string{"LICENSES/Acme.txt", "Ask first."}, repo("MIT"), "unknown", ""},
		"an unlicense file":                   {skill(""), []string{"UNLICENSE", unlicenseText}, repo("Unlicense"), "unknown", ""},
		"a license template is not a license": {skill(""), []string{"LICENSE_TEMPLATE.md", "Copyright <year> <owner>"}, repo("MIT"), "open", "MIT"},
		"a license script is not a license":   {skill(""), []string{"license_check.py", "print('proprietary license')"}, repo("MIT"), "open", "MIT"},
		// Licenses that allow reuse ask, as files do, but are not restricted for the words they use.
		"a GNU license":                     {skill(""), []string{"COPYING", gplText}, repo("GPL-2.0"), "unknown", ""},
		"the Unlicense":                     {skill(""), []string{"LICENSE", unlicenseText}, repo("Unlicense"), "unknown", ""},
		"any use spoken of in the body":     {"---\nname: a\n---\nFree for commercial and non-commercial use.\n", nil, repo("MIT"), "unknown", ""},
		"a notice that says proprietary":    {skill(""), []string{"NOTICE", "Portions are proprietary to Acme."}, repo("MIT"), "unknown", ""},
		"a non-commercial license declared": {skill("license: CC-BY-NC-4.0\n"), nil, repo("MIT"), "restricted", ""},
		// A value goes on through blank lines; any other key or section that names a license makes the skill ask.
		"blank lines in a folded license":     {skill("license: |\n  MIT\n\n  The prompts are proprietary to Acme.\n"), nil, repo("MIT"), "restricted", ""},
		"blank lines in a license list":       {skill("license:\n  - MIT\n\n  - Proprietary\n"), nil, repo("MIT"), "restricted", ""},
		"a license in a flow mapping":         {skill("metadata: {license: Proprietary}\n"), nil, repo("MIT"), "restricted", ""},
		"licenses as a list":                  {skill("licenses: [Proprietary]\n"), nil, repo("MIT"), "restricted", ""},
		"a key that points at the terms":      {skill("license-file: LICENSE.commercial\n"), nil, repo("MIT"), "unknown", ""},
		"a license item of another key":       {skill("metadata:\n- license: MIT\n"), nil, repo("NOASSERTION"), "unknown", ""},
		"a license section in the body":       {"---\nname: a\n---\n## License: Proprietary, internal use only\n", nil, repo("MIT"), "unknown", ""},
		"an SPDX line in the body":            {"---\nname: a\n---\n<!-- SPDX-License-Identifier: LicenseRef-Acme -->\nDo it.\n", nil, repo("MIT"), "unknown", ""},
		"a description that names a license":  {skill("description: Check the license of each dependency\n"), nil, repo("MIT"), "open", "MIT"},
		"a hidden character in a notice":      {skill(""), []string{"NOTICE", "Propr\u200bietary and confidential."}, repo("MIT"), "restricted", ""},
		"a hidden character in a declaration": {skill("license: Propr\u200bietary\n"), nil, repo("MIT"), "restricted", ""},
		// A license file is known by any word of its name, at the top or one folder down outside an asset folder.
		"a license named after its kind":    {skill(""), []string{"COMMERCIAL-LICENSE.md", "Ask Acme for a key."}, repo("MIT"), "unknown", ""},
		"a commercial license as Sidekiq's": {skill(""), []string{"COMM-LICENSE.txt", "Proprietary terms: a license is required."}, repo("MIT"), "restricted", ""},
		"an EULA after a name":              {skill(""), []string{"ACME_EULA.pdf", "%PDF-1.7 binary"}, repo("MIT"), "unknown", ""},
		"an agreement spelled out":          {skill(""), []string{"END-USER-LICENSE-AGREEMENT.md", "Terms."}, repo("MIT"), "unknown", ""},
		"a license in CamelCase":            {skill(""), []string{"CommercialLicense.md", "Terms."}, repo("MIT"), "unknown", ""},
		"a license one folder down":         {skill(""), []string{"legal/LICENSE.md", "Terms."}, repo("MIT"), "unknown", ""},
		"third-party notices":               {skill(""), []string{"ThirdPartyNotices.txt", "Copyright Acme. All rights reserved."}, repo("MIT"), "unknown", ""},
		"a folder named like a license":     {skill(""), []string{"license-checker/guide.md", "How to check a license."}, repo("MIT"), "open", "MIT"},
		"a license in a templates folder":   {skill(""), []string{"templates/LICENSE-MIT.txt", mitText}, repo("MIT"), "open", "MIT"},
		"a license two folders down":        {skill(""), []string{"legal/en/LICENSE.md", "Terms."}, repo("MIT"), "open", "MIT"},
		// Any use is set aside only where it is allowed; refused, its words stay and read as terms.
		"any use refused in a notice":       {skill(""), []string{"NOTICE", "This skill may not be reproduced for commercial or non-commercial purposes without written permission."}, repo("MIT"), "restricted", ""},
		"any use refused in the body":       {"---\nname: a\n---\nYou may not use it for any purpose, commercial or non-commercial, without a license.\n", nil, repo("MIT"), "unknown", ""},
		"a notice that carries a GNU text":  {skill(""), []string{"NOTICE", "GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\nEveryone is permitted to copy and distribute verbatim copies of this license document."}, repo("MIT"), "unknown", ""},
		"a GNU title over a notice's terms": {skill(""), []string{"NOTICE", "GNU GENERAL PUBLIC LICENSE\nConfidential. Not for distribution."}, repo("MIT"), "unknown", ""},
		// Close variants of a license section or key.
		"a licensing section":          {"---\nname: a\n---\n## Licensing\n\nAsk Acme first.\n", nil, repo("MIT"), "unknown", ""},
		"a license line in bold":       {"---\nname: a\n---\n**License:** Proprietary\n", nil, repo("MIT"), "unknown", ""},
		"a copyright line":             {"---\nname: a\n---\nDo the thing.\n\nCopyright 2026 Acme.\n", nil, repo("MIT"), "unknown", ""},
		"a key with spaces":            {skill("License Terms: ask Acme\n"), nil, repo("MIT"), "unknown", ""},
		"terms of use as a key":        {skill("Terms of Use: Acme customers only\n"), nil, repo("MIT"), "unknown", ""},
		"a restrictions key":           {skill("restrictions: proprietary\n"), nil, repo("MIT"), "restricted", ""},
		"a comment in the frontmatter": {skill("# The method text is proprietary to Acme\n"), nil, repo("MIT"), "unknown", ""},
		// Characters that draw nothing, and the long s, hide no word.
		"a soft hyphen in a declaration":   {skill("license: Propri\u00adetary\n"), nil, repo("MIT"), "restricted", ""},
		"a variation selector in a notice": {skill(""), []string{"NOTICE", "All rights re\ufe0fserved."}, repo("MIT"), "unknown", ""},
		"a long s in a notice":             {skill(""), []string{"NOTICE", "Not for di\u017ftribution."}, repo("MIT"), "restricted", ""},
		// A phrase reads the same wrapped, spaced twice or with no-break spaces.
		"a wrapped reservation in a notice": {skill(""), []string{"NOTICE", "Copyright Acme Corporation and its affiliates. All rights\n  reserved."}, repo("MIT"), "unknown", ""},
		"a wrapped refusal in a notice":     {skill(""), []string{"NOTICE", "Not for\nredistribution."}, repo("MIT"), "restricted", ""},
		"no-break spaces in the body":       {"---\nname: a\n---\nDo it.\n\nAcme. All\u00a0rights\u00a0reserved.\n", nil, repo("MIT"), "unknown", ""},
		// Any use spoken of anywhere but a license file makes the skill ask, whichever way the sentence goes.
		"any use allowed in a notice":     {skill(""), []string{"NOTICE", "Free for commercial and non-commercial use."}, repo("MIT"), "unknown", ""},
		"any use refused after the words": {skill(""), []string{"NOTICE", "Use for any purpose, commercial or non-commercial, is prohibited without a license."}, repo("MIT"), "unknown", ""},
		"either use refused":              {skill(""), []string{"NOTICE", "Either commercial or non-commercial use of this skill is prohibited."}, repo("MIT"), "unknown", ""},
		"any use in a license file":       {skill(""), []string{"LICENSE", "Free for commercial and non-commercial use."}, repo("MIT"), "unknown", ""},
		// Code blocks show examples; a block never closed is read all the same.
		"a license in a code example":   {"---\nname: a\n---\nWrite the frontmatter:\n\n```yaml\nlicense: MIT\n```\n\n~~~\n# Copyright 2025 Google LLC\n~~~\n", nil, repo("MIT"), "open", "MIT"},
		"a license after an open fence": {"---\nname: a\n---\n```\n## License: Proprietary\n", nil, repo("MIT"), "unknown", ""},
		// A license file one folder down counts outside content folders; any file of a terms folder counts.
		"a reference about licenses":  {skill(""), []string{"references/license-compatibility.md", "MIT and GPL compared."}, repo("MIT"), "open", "MIT"},
		"docs about licensing":        {skill(""), []string{"docs/licensing.md", "How to license your work."}, repo("MIT"), "open", "MIT"},
		"a dataset's own license":     {skill(""), []string{"data/LICENSE", "CC BY-NC 4.0: non-commercial use only."}, repo("MIT"), "open", "MIT"},
		"a license in another folder": {skill(""), []string{"meta/LICENSE.md", "Terms."}, repo("MIT"), "unknown", ""},
		"any file of a legal folder":  {skill(""), []string{"legal/privacy.md", "We keep nothing."}, repo("MIT"), "unknown", ""},
		// Frontmatter lines beyond the license keys: a comment or another key's value asks, the skill's own fields do not.
		"a comment that reads as terms":   {skill("# Handles confidential documents\n"), nil, repo("MIT"), "unknown", ""},
		"another key that reads as terms": {skill("usage: confidential\n"), nil, repo("MIT"), "unknown", ""},
		"the skill's own fields":          {skill("tags: [confidential, legal]\ndescription: >\n  Drafts license agreements: NDAs and EULAs\n"), nil, repo("MIT"), "open", "MIT"},
		// The folder's README is read as SKILL.md's text is.
		"a README with a license section": {skill(""), []string{"README.md", "# Tool\n\n## License: Proprietary\n"}, repo("MIT"), "unknown", ""},
		"a README with a copyright line":  {skill(""), []string{"README.md", "# Tool\n\n\u00a9 2026 Acme\n"}, repo("MIT"), "unknown", ""},
		"a README without terms":          {skill(""), []string{"README.md", "# Tool\n\nUse it with care.\n"}, repo("MIT"), "open", "MIT"},
		// More names, and more lines a body names its terms with.
		"a license with a number":     {skill(""), []string{"LICENSE2.txt", "Terms."}, repo("MIT"), "unknown", ""},
		"a license after an acronym":  {skill(""), []string{"ACMELicense.pdf", "Terms."}, repo("MIT"), "unknown", ""},
		"a translated license":        {skill(""), []string{"LICENSE.cs", "Licence."}, repo("MIT"), "unknown", ""},
		"a numbered license line":     {"---\nname: a\n---\n1. License: Proprietary\n", nil, repo("MIT"), "unknown", ""},
		"a table line naming terms":   {"---\nname: a\n---\n| License | Proprietary |\n", nil, repo("MIT"), "unknown", ""},
		"a comment naming terms":      {"---\nname: a\n---\n<!-- License: Proprietary -->\nDo it.\n", nil, repo("MIT"), "unknown", ""},
		"a copyright mark and a year": {"---\nname: a\n---\nDo it.\n(c) 2026 Acme\n", nil, repo("MIT"), "unknown", ""},
		// Code blocks as CommonMark reads them: what renders as text is read, what renders as code is an example.
		"an indented code line is no fence": {"---\nname: a\n---\n    ```\n## License: Proprietary\n    ```\n", nil, repo("MIT"), "unknown", ""},
		"inline code is no fence":           {"---\nname: a\n---\n```x``` and more\n## License: Proprietary\n```x```\n", nil, repo("MIT"), "unknown", ""},
		"a fence closes on its own kind":    {"---\nname: a\n---\n````\n```\n## License: Proprietary\n````\nDo it.\n", nil, repo("MIT"), "open", "MIT"},
		"terms in a code example":           {"---\nname: a\n---\n```\n// SPDX-License-Identifier: Apache-2.0\n// Copyright (c) 2025 Acme. All rights reserved.\n```\n", nil, repo("MIT"), "open", "MIT"},
		// Markup between a phrase's words does not part them.
		"emphasis inside a phrase":  {"---\nname: a\n---\nThis skill is **proprietary** software.\n", nil, repo("MIT"), "unknown", ""},
		"an entity inside a phrase": {"---\nname: a\n---\nAll&nbsp;rights&nbsp;reserved.\n", nil, repo("MIT"), "unknown", ""},
		"a tag inside a phrase":     {"---\nname: a\n---\nAll rights<br>reserved.\n", nil, repo("MIT"), "unknown", ""},
		// A line names terms as a label, a heading or a statement, not as a verb or a field.
		"a verb is no label":       {"---\nname: a\n---\n1. License the music you use.\n- `license`: the package's SPDX id\n", nil, repo("MIT"), "open", "MIT"},
		"licensed under":           {"---\nname: a\n---\nLicensed under the Acme Commercial License.\n", nil, repo("MIT"), "unknown", ""},
		"a terms heading":          {"---\nname: a\n---\n## Terms\n\nAsk first.\n", nil, repo("MIT"), "unknown", ""},
		"terms and conditions":     {"---\nname: a\n---\nTerms and conditions apply.\n", nil, repo("MIT"), "unknown", ""},
		"a license link":           {"---\nname: a\n---\n- [License](https://example.test/terms)\n", nil, repo("MIT"), "unknown", ""},
		"another key's long value": {skill("notes: |\n  Proprietary to Acme.\n"), nil, repo("MIT"), "unknown", ""},
		// Names that read as code are not licenses; a translation and other names for terms are.
		"a license script":          {skill(""), []string{"license_check.sh", "echo"}, repo("MIT"), "open", "MIT"},
		"a license module":          {skill(""), []string{"license.ts", "export {}"}, repo("MIT"), "open", "MIT"},
		"a license validator":       {skill(""), []string{"License.cs", "class License {}"}, repo("MIT"), "open", "MIT"},
		"a Polish license":          {skill(""), []string{"LICENSE.pl", "Licencja."}, repo("MIT"), "unknown", ""},
		"a legal file":              {skill(""), []string{"LEGAL.md", "Terms."}, repo("MIT"), "unknown", ""},
		"an agreement":              {skill(""), []string{"AGREEMENT.md", "Terms."}, repo("MIT"), "unknown", ""},
		"terms of use after a name": {skill(""), []string{"ACME_TERMS_OF_USE.md", "Terms."}, repo("MIT"), "unknown", ""},
		"a name that ends in terms": {skill(""), []string{"search-terms.txt", "words"}, repo("MIT"), "open", "MIT"},
		// Another name with terms in it is read, and asks only when it reads as terms.
		"a company's terms":                        {skill(""), []string{"ACME_TERMS.md", "Commercial use requires a license. All rights reserved."}, repo("MIT"), "unknown", ""},
		"a company's refusal":                      {skill(""), []string{"ACME_TERMS.md", "Proprietary terms: ask Acme first."}, repo("MIT"), "restricted", ""},
		"a glossary of key terms":                  {skill(""), []string{"glossary-terms.md", "Prompt: what the model reads.\nNode: one step."}, repo("MIT"), "open", "MIT"},
		"a copyright in a script without capitals": {"---\nname: a\n---\nDo it.\n\nCopyright 腾讯\n", nil, repo("MIT"), "unknown", ""},
		"a comment opened again":                   {"---\nname: a\n---\n<!-- one -->\n<!-- two\n--> text <!--\n```\n-->\n## License: Proprietary\n<!--\n```\n-->\n", nil, repo("MIT"), "unknown", ""},
		"a terms file":                             {skill(""), []string{"TERMS.md", "Ask first."}, repo("MIT"), "unknown", ""},
		// Folders: a terms file kept in docs/ counts, a glossary in terms/ does not; READMEs of other languages are read.
		"a license kept in docs": {skill(""), []string{"docs/LICENSE.md", "Terms."}, repo("MIT"), "unknown", ""},
		"a glossary of terms":    {skill(""), []string{"terms/glossary.md", "A word list."}, repo("MIT"), "open", "MIT"},
		"a localized README":     {skill(""), []string{"README_CN.md", "# Tool\n\n## License: Proprietary\n"}, repo("MIT"), "unknown", ""},
		"a scaffold's license":   {skill(""), []string{"templates/LICENSE", mitText}, repo("MIT"), "open", "MIT"},
		// More ways a page names its terms, and the ones it does not.
		"a label after a dash":          {"---\nname: a\n---\nLicense \u2013 Proprietary\n", nil, repo("MIT"), "unknown", ""},
		"a bold label after a dash":     {"---\nname: a\n---\n**License** \u2014 Commercial\n", nil, repo("MIT"), "unknown", ""},
		"a heading after an emoji":      {"---\nname: a\n---\n## \U0001F4C4 License\n\nAsk first.\n", nil, repo("MIT"), "unknown", ""},
		"a numbered heading":            {"---\nname: a\n---\n## 5. License\n\nAsk first.\n", nil, repo("MIT"), "unknown", ""},
		"licensed to some":              {"---\nname: a\n---\nLicensed to Acme customers only.\n", nil, repo("MIT"), "unknown", ""},
		"an HTML heading":               {"---\nname: a\n---\n<h2>License</h2>\n<p>Ask first.</p>\n", nil, repo("MIT"), "unknown", ""},
		"an HTML label":                 {"---\nname: a\n---\n<b>License:</b> Proprietary\n", nil, repo("MIT"), "unknown", ""},
		"a legal label":                 {"---\nname: a\n---\nLegal: ask Acme first.\n", nil, repo("MIT"), "unknown", ""},
		"a copyright and a name":        {"---\nname: a\n---\nDo it.\n\nCopyright Acme Corp.\n", nil, repo("MIT"), "unknown", ""},
		"words that are no label":       {"---\nname: a\n---\nCopyright law basics are covered below.\nLicense-free tools only.\n", nil, repo("MIT"), "open", "MIT"},
		"an entity standing for hiding": {"---\nname: a\n---\nAll rights rese&#8203;rved.\n", nil, repo("MIT"), "unknown", ""},
		"an entity hiding in a label":   {"---\nname: a\n---\n&#76;icense: Proprietary\n", nil, repo("MIT"), "unknown", ""},
		"an arrow is no tag":            {"---\nname: a\n---\n<-- Proprietary, not for redistribution -->\n", nil, repo("MIT"), "unknown", ""},
		"a fence inside a comment":      {"---\nname: a\n---\n<!--\n```\n-->\n## License: Proprietary\n<!--\n```\n-->\n", nil, repo("MIT"), "unknown", ""},
	} {
		got := registryLicenseOf(snapshotOf(t, c.markdown, c.files...), c.repo)
		if got.Status != c.status || got.SPDX != c.spdx {
			t.Fatalf("%s: %+v", name, got)
		}
	}
	if got := registryLicenseOf(snapshotOf(t, "# no frontmatter, license: MIT\n"), repo("MIT")); got.Status == "open" {
		t.Fatal("a SKILL.md without a readable frontmatter is never open")
	}
	// Every license and notice file read is shown; a long one in part, judged on its whole text.
	long := snapshotOf(t, skill(""), "NOTICE", "Credits.", "LICENSE.md", strings.Repeat("Some terms. ", 3000)+"Not for redistribution.")
	got := registryLicenseOf(long, registryRepository{})
	if got.Status != "restricted" || len(got.Files) != 2 || got.Files[0].Path != "LICENSE.md" || !got.Files[0].Truncated || len(got.Files[0].Text) != maxRegistryLicenseText ||
		got.Files[1].Path != "NOTICE" || !got.Files[1].Notice || got.Files[1].Text != "Credits." {
		t.Fatalf("license files shown wrongly: %+v", got)
	}
	if none := registryLicenseOf(snapshotOf(t, skill("license: MIT\n")), registryRepository{}); none.Files == nil {
		t.Fatal("no license files is an empty list")
	}
}

// What a member confirms by importing from a preview: the skill's text, every license and notice file as it was, and
// the repository's license.
func TestRegistryPreviewHashCoversTheTextTheTermsAndTheRepositoryLicense(t *testing.T) {
	mit := registryRepository{Checked: true, Found: true, License: "MIT"}
	base := snapshotOf(t, registryTestSkill, "LICENSE", mitText)
	hash := registryPreviewHash(base, mit)
	for name, other := range map[string]string{
		"another text":           registryPreviewHash(snapshotOf(t, registryTestSkill+"More.\n", "LICENSE", mitText), mit),
		"other terms":            registryPreviewHash(snapshotOf(t, registryTestSkill, "LICENSE", mitText+"Non-commercial use only.\n"), mit),
		"a notice added":         registryPreviewHash(snapshotOf(t, registryTestSkill, "LICENSE", mitText, "NOTICE", "Credits."), mit),
		"the license renamed":    registryPreviewHash(snapshotOf(t, registryTestSkill, "LICENSE.md", mitText), mit),
		"another repo license":   registryPreviewHash(base, registryRepository{Checked: true, Found: true, License: "GPL-3.0"}),
		"the repository missing": registryPreviewHash(base, registryRepository{Checked: true}),
		"repository unchecked":   registryPreviewHash(base, registryRepository{}),
	} {
		if other == hash {
			t.Fatalf("%s: the preview hash did not change", name)
		}
	}
	// The README is read for terms, so it is in the hash whether or not it has any.
	if snapshotOf(t, registryTestSkill, "README.md", "Use it.").Hash == snapshotOf(t, registryTestSkill, "README.md", "Use it with care.").Hash {
		t.Fatal("the README is not in the hash")
	}
	// Each part is counted, so moving text between the files changes the hash too.
	if snapshotOf(t, registryTestSkill, "LICENSE", "a\x00NOTICE\x00b").Hash == snapshotOf(t, registryTestSkill, "LICENSE", "a", "NOTICE", "b").Hash {
		t.Fatal("two folders gave one hash")
	}
	if registryPreviewHash(snapshotOf(t, registryTestSkill, "scripts/run.sh", "echo", "LICENSE", mitText), mit) != hash {
		t.Fatal("a file that is neither the skill's text nor its terms changed the hash")
	}
	if registryPreviewHash(base, registryRepository{Checked: true, Found: true, License: "MIT", Stars: 9, Archived: true}) != hash {
		t.Fatal("the repository's stars are advice, not terms")
	}
	// Two license files under one name cannot both be in the hash, so such a folder is refused.
	value, _ := json.Marshal(map[string]any{"hash": registryTestUpstreamHash, "files": []map[string]string{
		{"path": "SKILL.md", "contents": registryTestSkill}, {"path": "LICENSE", "contents": mitText}, {"path": "LICENSE\u200b", "contents": "Proprietary."}}})
	if _, err := parseRegistrySnapshot(value); registryCode(err) != "skill_registry_upstream" {
		t.Fatal("two license files under one name accepted", err)
	}
}

// registryPlain drops exactly what hiddenTextProblem refuses.
// The quick look never skips a text a pattern matches: a rune (?i) reads as an ASCII letter is that letter to it.
func TestRegistryFoldLeavesNoMatchUnread(t *testing.T) {
	for r := rune(0x80); r <= unicode.MaxRune; r++ {
		for f := unicode.SimpleFold(r); f != r; f = unicode.SimpleFold(f) {
			if f < 0x80 && unicode.IsLetter(f) && registryFold(string(r)) != string(unicode.ToLower(f)) {
				t.Fatalf("U+%04X folds to %q but the quick look reads %q", r, f, registryFold(string(r)))
			}
		}
	}
	if !readRegistryTerms("All rights re\u017ferved").has(registryReserved, "reserved") {
		t.Fatal("a long s hid the words from the quick look")
	}
}

// What draws nothing is left out wherever it sits in a word; letters of every script stay.
func TestRegistryPlainDropsWhatDrawsNothing(t *testing.T) {
	for _, s := range []string{"Propri\u00adetary", "Propri\u2062etary", "Propri\ufe0fetary", "Propri\u034fetary", "Propri\U000e0100etary", "Propri\u200betary", "Propri\u3164etary"} {
		if got := registryPlain(s); got != "Proprietary" {
			t.Fatalf("%q read as %q", s, got)
		}
	}
	if s := "许可 Lizenz licença лицензия"; registryPlain(s) != s {
		t.Fatal("letters were dropped")
	}
}

func TestRegistryHiddenRunesAreTheOnesSkillsRefuse(t *testing.T) {
	for r := rune(0); r <= unicode.MaxRune; r++ {
		if r >= 0xd800 && r <= 0xdfff {
			continue
		}
		if registryHiddenRune(r) != (hiddenTextProblem(string(r)) != "") {
			t.Fatalf("U+%04X: registry %v, skills %q", r, registryHiddenRune(r), hiddenTextProblem(string(r)))
		}
	}
}
