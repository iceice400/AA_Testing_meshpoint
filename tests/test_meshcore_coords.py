import unittest

from src.decode.meshcore_coords import meshcore_coords_from_mapping


class TestMeshcoreCoords(unittest.TestCase):
    def test_adv_lat_lon(self):
        coords = meshcore_coords_from_mapping({
            "adv_lat": 28.5383,
            "adv_lon": -81.3792,
        })
        self.assertIsNotNone(coords)
        self.assertAlmostEqual(coords[0], 28.5383)
        self.assertAlmostEqual(coords[1], -81.3792)

    def test_zero_zero_is_no_fix(self):
        self.assertIsNone(meshcore_coords_from_mapping({
            "adv_lat": 0.0,
            "adv_lon": 0.0,
        }))

    def test_microdegree_integers(self):
        coords = meshcore_coords_from_mapping({
            "latitude": 285383000,
            "longitude": -813792000,
        })
        self.assertIsNotNone(coords)
        self.assertAlmostEqual(coords[0], 28.5383, places=3)
        self.assertAlmostEqual(coords[1], -81.3792, places=3)

    def test_nested_advert(self):
        coords = meshcore_coords_from_mapping({
            "advert": {"adv_lat": 40.7, "adv_lon": -74.0},
        })
        self.assertIsNotNone(coords)
        self.assertAlmostEqual(coords[0], 40.7)
        self.assertAlmostEqual(coords[1], -74.0)


if __name__ == "__main__":
    unittest.main()
