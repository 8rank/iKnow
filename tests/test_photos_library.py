"""The Photos library lookup, with no store and no mounted disk involved.

Run from the repository root:

    python3 -m unittest discover -s tests

The mounted-volume search is exercised with a patched `glob`, so the suite says
the same thing on a Mac that does keep its library on an external disk; reading
a real one is checked by hand.
"""

import os
import tempfile
import unittest
from unittest import mock

from api import db


class PhotosLibraryTest(unittest.TestCase):
    """Every case runs against a throwaway HOME, so no real library is read."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = tmp.name
        env = mock.patch.dict(os.environ, {"HOME": self.home})
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("KG_PHOTOS", None)
        self.addCleanup(os.environ.pop, "KG_PHOTOS", None)
        saved = dict(db.LIVE_SOURCES)
        self.addCleanup(db.LIVE_SOURCES.update, saved)

    def make_library(self, name="Photos Library.photoslibrary", under=None):
        """Build a sparse library: the index and the folders above it."""
        base = os.path.join(under or self.home, name)
        os.makedirs(os.path.join(base, "database"), exist_ok=True)
        index = os.path.join(base, "database", "Photos.sqlite")
        with open(index, "w"):
            pass
        return base, index

    def pictures(self):
        return os.path.join(self.home, "Pictures")

    # --- the default locations -------------------------------------------

    def test_default_library_is_used(self):
        os.makedirs(self.pictures())
        _, index = self.make_library(under=self.pictures())
        self.assertEqual(db._photos_library(), index)

    def test_another_library_in_pictures_is_found(self):
        os.makedirs(self.pictures())
        _, index = self.make_library("Archives.photoslibrary", under=self.pictures())
        self.assertEqual(db._photos_library(), index)

    def test_nothing_found_returns_the_default_path(self):
        with mock.patch.object(db.glob, "glob", return_value=[]):
            self.assertEqual(
                db._photos_library(),
                os.path.join(self.pictures(), "Photos Library.photoslibrary",
                             "database", "Photos.sqlite"))

    # --- the fallback search ----------------------------------------------

    def test_a_library_on_another_volume_is_used(self):
        _, index = self.make_library("External.photoslibrary")
        with mock.patch.object(db.glob, "glob", return_value=[index]):
            self.assertEqual(db._photos_library(), index)

    def test_pictures_is_preferred_to_a_mounted_volume(self):
        os.makedirs(self.pictures())
        _, local = self.make_library(under=self.pictures())
        _, external = self.make_library("External.photoslibrary")

        def glob(pattern):
            # The volume scan must not even be reached once ~/Pictures answers.
            return [external] if "Volumes" in pattern else [local]

        with mock.patch.object(db.glob, "glob", side_effect=glob):
            self.assertEqual(db._photos_library(), local)

    # --- KG_PHOTOS --------------------------------------------------------

    def test_kg_photos_takes_the_library_bundle(self):
        base, index = self.make_library()
        os.environ["KG_PHOTOS"] = base
        self.assertEqual(db._photos_library(), index)

    def test_kg_photos_takes_the_database_directory(self):
        base, index = self.make_library()
        os.environ["KG_PHOTOS"] = os.path.join(base, "database")
        self.assertEqual(db._photos_library(), index)

    def test_kg_photos_takes_the_index_file(self):
        _, index = self.make_library()
        os.environ["KG_PHOTOS"] = index
        self.assertEqual(db._photos_library(), index)

    def test_kg_photos_wins_over_the_default(self):
        os.makedirs(self.pictures())
        self.make_library(under=self.pictures())
        base, index = self.make_library("Elsewhere.photoslibrary")
        os.environ["KG_PHOTOS"] = base
        self.assertEqual(db._photos_library(), index)

    def test_kg_photos_expands_a_home_path(self):
        base, index = self.make_library()
        os.environ["KG_PHOTOS"] = "~/" + os.path.basename(base)
        self.assertEqual(db._photos_library(), index)


if __name__ == "__main__":
    unittest.main()
