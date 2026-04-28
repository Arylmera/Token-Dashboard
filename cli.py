"""Back-compat shim. Real entrypoint lives in token_dashboard/__main__.py."""
from token_dashboard.__main__ import main

if __name__ == "__main__":
    main()
