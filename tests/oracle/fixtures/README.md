# Native oracle inputs

The platform references and reviewed catalog in this directory are exact copies from upstream `381d52b3`. Its native goldens were recorded against those inputs. The fork intentionally removed iOS guidance and changed catalog validation/review handling; the default JavaScript suites continue to test those fork inputs. Keeping both inputs prevents a source-file collision from changing what a frozen native oracle case measures. No golden or function-level vector is regenerated.
