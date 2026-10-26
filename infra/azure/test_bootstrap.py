import copy
import unittest
from bootstrap import validate_network

class NetworkBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.config={"vnetId":"/subscriptions/s/resourceGroups/network/providers/Microsoft.Network/virtualNetworks/shared", "postgresSubnetPrefix":"10.20.10.0/27", "appsSubnetPrefix":"10.20.0.0/21"}
        self.apps=self.config["vnetId"]+"/subnets/apps"
        self.env={"properties":{"vnetConfiguration":{"infrastructureSubnetId":self.apps}}}
        self.network={"addressSpace":{"addressPrefixes":["10.20.0.0/16"]},"subnets":[{"id":self.apps,"name":"apps","addressPrefix":"10.20.0.0/21"},{"id":"mysql","name":"mysql","addressPrefix":"10.20.8.0/24"}]}
    def test_accepts_unallocated_private_subnet(self):
        validate_network(self.config,self.network,self.env)
    def test_rejects_overlap_with_an_existing_application(self):
        for prefix in ["10.20.1.0/27","10.20.8.0/27"]:
            with self.subTest(prefix=prefix), self.assertRaisesRegex(ValueError,"overlaps"):
                validate_network({**self.config,"postgresSubnetPrefix":prefix},self.network,self.env)
    def test_rejects_address_outside_network_or_too_small(self):
        for prefix in ["10.21.10.0/27","10.20.10.0/29"]:
            with self.subTest(prefix=prefix), self.assertRaisesRegex(ValueError,"must fit"):
                validate_network({**self.config,"postgresSubnetPrefix":prefix},self.network,self.env)
    def test_rejects_unrelated_environment_and_stale_application_prefix(self):
        with self.assertRaisesRegex(ValueError,"different VNet"):
            validate_network(self.config,self.network,{"properties":{"vnetConfiguration":{"infrastructureSubnetId":"/another/network/subnets/apps"}}})
        with self.assertRaisesRegex(ValueError,"does not match"):
            validate_network({**self.config,"appsSubnetPrefix":"10.20.9.0/24"},self.network,self.env)
    def test_resume_requires_matching_postgres_delegation(self):
        network=copy.deepcopy(self.network)
        subnet={"id":"wallet","name":"snet-wallet-postgres","addressPrefix":"10.20.10.0/27","delegations":[{"serviceName":"Microsoft.DBforPostgreSQL/flexibleServers"}]}
        network["subnets"].append(subnet)
        validate_network(self.config,network,self.env)
        subnet["delegations"]=[]
        with self.assertRaisesRegex(ValueError,"does not match"):
            validate_network(self.config,network,self.env)

if __name__=="__main__": unittest.main()
